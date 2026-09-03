// soundmodem.go — QtSoundModem subprocess manager.
//
// Each audio channel gets one QtSoundModem instance with up to 4 modem
// sub-channels (A/B/C/D).  Audio is fed as raw int16 LE mono PCM via stdin.
// Decoded AX.25 frames are read from the KISS TCP server.
// Monitor text and DCD activity are read from the AGW PE TCP server.
//
// Wire protocol sent on resultChan (backend → web layer):
//
//	0x20  AX.25 packet frame
//	      [type:1=0x20][kiss_port:1][snr:4 float32 LE][frame_len:4 uint32 BE][ax25_frame: N bytes]
//	0x21  Error
//	      [type:1=0x21][msg_len:4 uint32 BE][msg: UTF-8]
//	0x23  DCD activity pulse
//	      [type:1=0x23][channel:1][dcd_on:1]
//	0x24  Monitor text
//	      [type:1=0x24][channel:1][is_tx:1][text_len:4 uint32 BE][text: UTF-8]
//	0x25  Process log line (stderr from QtSoundModem)
//	      [type:1=0x25][line_len:4 uint32 BE][line: UTF-8]
package main

import (
	"bufio"
	"encoding/binary"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"os"
	"os/exec"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
	"unsafe"
)

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const (
	smBinaryPath = "/usr/local/bin/QtSoundModem"

	// Port pool: KISS=base+2*n, AGW=base+2*n+1
	smPortBase = 18200
	smPortSize = 100 // max concurrent channel instances

	smKissConnectTimeout = 10 * time.Second
	smKissRetryInterval  = 200 * time.Millisecond
	smAGWConnectTimeout  = 10 * time.Second
	smAGWRetryInterval   = 200 * time.Millisecond
	smKissReadBufSize    = 4096
	smAGWHeaderSize      = 36
	smStopTimeout        = 3 * time.Second

	kissFrameEnd  = 0xC0
	kissFrameEsc  = 0xDB
	kissTFrameEnd = 0xDC
	kissTFrameEsc = 0xDD

	agwKindMonitorUI  = 'U'
	agwKindMonitorI   = 'I'
	agwKindMonitorS   = 'S'
	agwKindMonitorT   = 'T'
	agwKindVersion    = 'R'
	agwKindPortInfo   = 'G'
	agwKindMonitorRaw = 'K'

	MsgPacket  = 0x20
	MsgError   = 0x21
	MsgDCD     = 0x23
	MsgMonitor = 0x24
	MsgLog     = 0x25
)

// ---------------------------------------------------------------------------
// Global port pool
// ---------------------------------------------------------------------------

var (
	smPortMu    sync.Mutex
	smUsedSlots = make(map[int]bool)
)

func smAcquireSlot() (kissPort, agwPort, slot int, err error) {
	smPortMu.Lock()
	defer smPortMu.Unlock()
	for i := 0; i < smPortSize; i++ {
		if !smUsedSlots[i] {
			smUsedSlots[i] = true
			return smPortBase + i*2, smPortBase + i*2 + 1, i, nil
		}
	}
	return 0, 0, 0, fmt.Errorf("no free QtSoundModem port slots (max %d)", smPortSize)
}

func smReleaseSlot(slot int) {
	smPortMu.Lock()
	delete(smUsedSlots, slot)
	smPortMu.Unlock()
}

// ---------------------------------------------------------------------------
// Configuration types
// ---------------------------------------------------------------------------

// SMChannelConfig holds per-modem-channel configuration.
// QtSoundModem supports up to 4 channels (A/B/C/D).
type SMChannelConfig struct {
	Enabled   bool    `json:"enabled"`
	ModemType int     `json:"modem"`      // 0=AFSK300, 1=AFSK1200, etc.
	Freq      float64 `json:"freq"`       // centre frequency Hz
	RcvrPairs int     `json:"rcvr_pairs"` // 0–8
	FX25      int     `json:"fx25"`       // 0=off, 1=RX only
	IL2P      int     `json:"il2p"`       // 0=off, 1=IL2P, 2=IL2P+CRC, 3=both
}

// SMConfig holds the full configuration for one QtSoundModem instance.
type SMConfig struct {
	SampleRate   int                `json:"sample_rate"`
	DCDThreshold int                `json:"dcd_threshold"`
	Channels     [4]SMChannelConfig `json:"channels"`
}

const smSampleRate = 12000 // UberSDR always delivers 12 kHz mono for USB/LSB

// sampleRateMismatch reports whether a stream's sample rate disagrees with the
// fixed rate buildSMIni configures the soundmodem at.
//
// The two are independent: the stream rate arrives in the audio packet header
// and the modem rate is this constant, so nothing makes them agree
// automatically. They do agree in practice -- the server's usb/lsb presets are
// 12 kHz, confirmed against a live receiver -- but a preset change would
// otherwise show up only as AX.25 that silently stops decoding.
func sampleRateMismatch(streamRate int) bool {
	return streamRate > 0 && streamRate != smSampleRate
}

func defaultSMConfig(_ int) SMConfig {
	cfg := SMConfig{
		SampleRate:   smSampleRate,
		DCDThreshold: 20,
	}
	cfg.Channels[0] = SMChannelConfig{
		Enabled:   true,
		ModemType: 1,
		Freq:      1700,
		RcvrPairs: 0,
		FX25:      1,
		IL2P:      0,
	}
	return cfg
}

// ---------------------------------------------------------------------------
// INI builder
// ---------------------------------------------------------------------------

func buildSMIni(cfg SMConfig, agwPort, kissPort int) string {
	// Always use the fixed sample rate — UberSDR delivers 12 kHz mono for USB/LSB.
	cfg.SampleRate = smSampleRate

	var b strings.Builder

	fmt.Fprintf(&b, "[AGWHost]\nPort=%d\nServer=1\n\n", agwPort)

	chNames := []string{"A", "B", "C", "D"}
	for i, name := range chNames {
		ch := cfg.Channels[i]
		fx25 := ch.FX25
		if !ch.Enabled {
			fx25 = 0
		}
		fmt.Fprintf(&b, "[AX25_%s]\n", name)
		fmt.Fprintf(&b, "BitRecovery=0\nDynamicFrack=0\nExcludeAPRSFrmType=\nExcludeCallsigns=\n")
		fmt.Fprintf(&b, "FX25=%d\nFrackTime=5\nFrameCollector=6\nHiToneRaise=0\n", fx25)
		fmt.Fprintf(&b, "IL2P=%d\nIL2PCRC=0\nIPOLL=80\nIdleTime=180\n", ch.IL2P)
		fmt.Fprintf(&b, "KISSOptimization=0\nMEMRecovery=200\nMaxframe=3\nMyDigiCall=\n")
		fmt.Fprintf(&b, "NonAX25Frm=0\nPersist=128\nRSID_SABM=0\nRSID_SetModem=0\nRSID_UI=0\n")
		fmt.Fprintf(&b, "RespTime=1500\nRetries=15\nSlotTime=100\nTXFrmMode=1\n\n")
	}

	fmt.Fprintf(&b, "[Init]\n")
	fmt.Fprintf(&b, "CM108Addr=/dev/hidraw0\nDispMode=0\nDualPTT=0\n")
	fmt.Fprintf(&b, "FLRigHost=127.0.0.1\nFLRigPort=12345\n")
	fmt.Fprintf(&b, "HamLibHost=127.0.0.1\nHamLibPort=4532\n")
	fmt.Fprintf(&b, "MinimizetoTray=0\nPTT=\nPTTBAUD=19200\nPTTMode=1\n")
	fmt.Fprintf(&b, "PTTOffString=\nPTTOnString=\n")
	fmt.Fprintf(&b, "RXSampleRate=%d\nSCO=0\n", cfg.SampleRate)
	fmt.Fprintf(&b, "SndRXDeviceName=stdin\nSndTXDeviceName=null\nSoundMode=0\n")
	fmt.Fprintf(&b, "TXPort=8884\nTXRotate=0\nTXSampleRate=%d\n", cfg.SampleRate)
	fmt.Fprintf(&b, "UDPClientPort=8888\nUDPHost=127.0.0.1\nUDPServer=0\nUDPServerPort=8884\n")
	fmt.Fprintf(&b, "WaterfallMax=3300\nWaterfallMin=0\ndarkTheme=false\nmultiCore=0\n")
	fmt.Fprintf(&b, "onlyMixSnoop=false\npttGPIOPin=17\npttGPIOPinR=17\ntxLatency=50\n")
	fmt.Fprintf(&b, "useKISSControls=false\n\n")

	fmt.Fprintf(&b, "[KISS]\nPort=%d\nServer=1\n\n", kissPort)

	fmt.Fprintf(&b, "[Modem]\n")
	fmt.Fprintf(&b, "CWIDCall=\nCWIDInterval=0\nCWIDLeft=0\nCWIDMark=\nCWIDRight=0\nCWIDType=1\n")
	fmt.Fprintf(&b, "DCDThreshold=%d\n", cfg.DCDThreshold)
	for i := 0; i < 4; i++ {
		mt := cfg.Channels[i].ModemType
		if !cfg.Channels[i].Enabled {
			mt = 0
		}
		fmt.Fprintf(&b, "ModemType%d=%d\n", i+1, mt)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "NRRcvrPairs%d=%d\n", i+1, cfg.Channels[i].RcvrPairs)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "PreEmphasisAll%d=0\nPreEmphasisDB%d=0\n", i+1, i+1)
	}
	for i := 0; i < 4; i++ {
		freq := cfg.Channels[i].Freq
		if freq <= 0 {
			freq = 1700
		}
		fmt.Fprintf(&b, "RXFreq%d=%.0f\n", i+1, freq)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "RcvrShift%d=30\n", i+1)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "TxDelay%d=250\n", i+1)
	}
	for i := 0; i < 4; i++ {
		fmt.Fprintf(&b, "TxTail%d=50\n", i+1)
	}
	fmt.Fprintf(&b, "afterTraffic=false\nrxOffset=0\n")
	for i := 0; i < 4; i++ {
		sc := 0
		if cfg.Channels[i].Enabled {
			sc = 1
		}
		fmt.Fprintf(&b, "soundChannel%d=%d\n", i+1, sc)
	}
	fmt.Fprintf(&b, "\n")

	fmt.Fprintf(&b, "[SixPack]\nDevice=\nEnable=0\nPort=0\n\n")
	fmt.Fprintf(&b, "[Window]\nWaterfall1=0\nWaterfall2=0\n")

	return b.String()
}

// ---------------------------------------------------------------------------
// SoundModemDecoder
// ---------------------------------------------------------------------------

// AudioSample carries a chunk of decoded mono S16LE PCM.
type AudioSample struct {
	PCMData []int16
}

// SoundModemDecoder manages one QtSoundModem subprocess.
type SoundModemDecoder struct {
	cfg      SMConfig
	kissPort int
	agwPort  int
	slot     int

	outputMode atomic.Value // stores string "ax25" (unused here, kept for future)

	tempDir string

	cmd   *exec.Cmd
	stdin io.WriteCloser

	kissConn net.Conn
	agwConn  net.Conn

	running   bool
	stopChan  chan struct{}
	crashChan chan error
	wg        sync.WaitGroup
	mu        sync.Mutex
}

// NewSoundModemDecoder allocates a port slot and creates the decoder.
func NewSoundModemDecoder(cfg SMConfig) (*SoundModemDecoder, error) {
	kissPort, agwPort, slot, err := smAcquireSlot()
	if err != nil {
		return nil, err
	}
	d := &SoundModemDecoder{
		cfg:       cfg,
		kissPort:  kissPort,
		agwPort:   agwPort,
		slot:      slot,
		crashChan: make(chan error, 1),
	}
	return d, nil
}

// Start launches the subprocess and begins goroutines.
// pc is used by kissReadLoop (to read pendingSNR) and agwReadLoop (to signal DCD events).
func (d *SoundModemDecoder) Start(audioChan <-chan AudioSample, resultChan chan<- []byte, pc *packetChannel) error {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.running {
		return fmt.Errorf("sound modem decoder already running")
	}

	tmpBase := "/dev/shm"
	if _, err := os.Stat(tmpBase); os.IsNotExist(err) {
		tmpBase = os.TempDir()
	}
	tempDir, err := os.MkdirTemp(tmpBase, "soundmodem-*")
	if err != nil {
		return fmt.Errorf("create temp dir: %w", err)
	}
	d.tempDir = tempDir

	iniPath := tempDir + "/QtSoundModem.ini"
	if err := os.WriteFile(iniPath, []byte(buildSMIni(d.cfg, d.agwPort, d.kissPort)), 0644); err != nil {
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("write ini: %w", err)
	}

	cmd := exec.Command(smBinaryPath, "nogui")
	cmd.Dir = tempDir
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("stderr pipe: %w", err)
	}
	stdin, err := cmd.StdinPipe()
	if err != nil {
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("stdin pipe: %w", err)
	}
	if err := cmd.Start(); err != nil {
		_ = stdin.Close()
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("start %s: %w", smBinaryPath, err)
	}
	if err := syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 10); err != nil {
		log.Printf("[SoundModem] renice pid %d: %v", cmd.Process.Pid, err)
	}

	d.cmd = cmd
	d.stdin = stdin
	d.stopChan = make(chan struct{})
	d.running = true

	log.Printf("[SoundModem pid=%d] started (KISS=%d AGW=%d dir=%s)",
		cmd.Process.Pid, d.kissPort, d.agwPort, tempDir)

	kissConn, err := d.connectWithRetry("KISS", d.kissPort, smKissConnectTimeout, smKissRetryInterval)
	if err != nil {
		d.running = false
		_ = stdin.Close()
		_ = cmd.Process.Kill()
		_ = cmd.Wait()
		_ = os.RemoveAll(tempDir)
		return fmt.Errorf("connect KISS port %d: %w", d.kissPort, err)
	}
	d.kissConn = kissConn

	agwConn, err := d.connectWithRetry("AGW", d.agwPort, smAGWConnectTimeout, smAGWRetryInterval)
	if err != nil {
		log.Printf("[SoundModem] AGW port %d unavailable: %v (DCD/monitor disabled)", d.agwPort, err)
	} else {
		d.agwConn = agwConn
		if err := d.sendAGWMonitorEnable(agwConn); err != nil {
			log.Printf("[SoundModem] AGW monitor enable: %v", err)
		}
	}

	d.wg.Add(4)
	go d.writeLoop(audioChan)
	go d.kissReadLoop(resultChan, pc)
	go d.waitLoop()
	go d.stderrReadLoop(stderrPipe, resultChan)
	if d.agwConn != nil {
		d.wg.Add(1)
		go d.agwReadLoop(resultChan, pc)
	}

	return nil
}

func (d *SoundModemDecoder) connectWithRetry(name string, port int, timeout, retry time.Duration) (net.Conn, error) {
	addr := fmt.Sprintf("127.0.0.1:%d", port)
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		conn, err := net.DialTimeout("tcp", addr, retry)
		if err == nil {
			log.Printf("[SoundModem] connected to %s port %d", name, port)
			return conn, nil
		}
		select {
		case <-d.stopChan:
			return nil, fmt.Errorf("stopped while waiting for %s port", name)
		default:
		}
		time.Sleep(retry)
	}
	return nil, fmt.Errorf("timeout waiting for %s port %d", name, port)
}

func (d *SoundModemDecoder) sendAGWMonitorEnable(conn net.Conn) error {
	hdr := make([]byte, smAGWHeaderSize)
	hdr[4] = 'm'
	_, err := conn.Write(hdr)
	return err
}

// Stop shuts down the subprocess and releases the port slot.
func (d *SoundModemDecoder) Stop() error {
	d.mu.Lock()
	if !d.running {
		d.mu.Unlock()
		return nil
	}
	d.running = false
	close(d.stopChan)
	if d.stdin != nil {
		_ = d.stdin.Close()
	}
	if d.kissConn != nil {
		_ = d.kissConn.Close()
	}
	if d.agwConn != nil {
		_ = d.agwConn.Close()
	}
	d.mu.Unlock()

	done := make(chan struct{})
	go func() { d.wg.Wait(); close(done) }()
	select {
	case <-done:
	case <-time.After(smStopTimeout):
		d.mu.Lock()
		if d.cmd != nil && d.cmd.Process != nil {
			_ = d.cmd.Process.Kill()
		}
		d.mu.Unlock()
		<-done
	}

	if d.tempDir != "" {
		_ = os.RemoveAll(d.tempDir)
	}
	smReleaseSlot(d.slot)
	log.Printf("[SoundModem] stopped")
	return nil
}

// CrashChan returns a channel that receives an error if the subprocess exits unexpectedly.
func (d *SoundModemDecoder) CrashChan() <-chan error {
	return d.crashChan
}

// ---------------------------------------------------------------------------
// Internal goroutines
// ---------------------------------------------------------------------------

func (d *SoundModemDecoder) writeLoop(audioChan <-chan AudioSample) {
	defer d.wg.Done()
	for {
		select {
		case <-d.stopChan:
			return
		case sample, ok := <-audioChan:
			if !ok {
				return
			}
			if len(sample.PCMData) == 0 {
				continue
			}
			n := len(sample.PCMData) * 2
			byteSlice := unsafe.Slice((*byte)(unsafe.Pointer(&sample.PCMData[0])), n)

			d.mu.Lock()
			stdin := d.stdin
			running := d.running
			d.mu.Unlock()

			if !running || stdin == nil {
				return
			}
			if _, err := stdin.Write(byteSlice); err != nil {
				if d.running {
					log.Printf("[SoundModem] stdin write: %v", err)
				}
				return
			}
		}
	}
}

func (d *SoundModemDecoder) kissReadLoop(resultChan chan<- []byte, pc *packetChannel) {
	defer d.wg.Done()

	buf := make([]byte, smKissReadBufSize)
	var frame []byte
	inFrame := false
	escaped := false

	for {
		select {
		case <-d.stopChan:
			return
		default:
		}

		d.mu.Lock()
		conn := d.kissConn
		d.mu.Unlock()
		if conn == nil {
			return
		}

		n, err := conn.Read(buf)
		if n > 0 {
			for _, b := range buf[:n] {
				if escaped {
					escaped = false
					switch b {
					case kissTFrameEnd:
						frame = append(frame, kissFrameEnd)
					case kissTFrameEsc:
						frame = append(frame, kissFrameEsc)
					default:
						frame = append(frame, b)
					}
					continue
				}
				switch b {
				case kissFrameEnd:
					if inFrame && len(frame) > 1 {
						kissPort := (frame[0] >> 4) & 0x0F
						kissCmd := frame[0] & 0x0F
						if kissCmd == 0 {
							ax25 := frame[1:]
							snr := pc.takePendingSNR()
							pkt := smEncodePacketFrame(kissPort, ax25, snr)
							select {
							case resultChan <- pkt:
							default:
								log.Printf("[SoundModem] result channel full, dropping frame")
							}
						}
					}
					frame = frame[:0]
					inFrame = false
				case kissFrameEsc:
					if inFrame {
						escaped = true
					}
				default:
					if !inFrame {
						inFrame = true
						frame = frame[:0]
					}
					frame = append(frame, b)
				}
			}
		}
		if err != nil {
			if err != io.EOF {
				d.mu.Lock()
				running := d.running
				d.mu.Unlock()
				if running {
					log.Printf("[SoundModem] KISS read: %v", err)
				}
			}
			return
		}
	}
}

func (d *SoundModemDecoder) waitLoop() {
	defer d.wg.Done()
	err := d.cmd.Wait()
	d.mu.Lock()
	running := d.running
	d.mu.Unlock()
	if running {
		exitDesc := "exited cleanly"
		if err != nil {
			exitDesc = err.Error()
		}
		log.Printf("[SoundModem] subprocess exited unexpectedly: %s", exitDesc)
		select {
		case d.crashChan <- fmt.Errorf("modem process exited: %s", exitDesc):
		default:
		}
	}
}

func (d *SoundModemDecoder) agwReadLoop(resultChan chan<- []byte, pc *packetChannel) {
	defer d.wg.Done()
	hdr := make([]byte, smAGWHeaderSize)
	for {
		select {
		case <-d.stopChan:
			return
		default:
		}
		d.mu.Lock()
		conn := d.agwConn
		d.mu.Unlock()
		if conn == nil {
			return
		}
		if _, err := io.ReadFull(conn, hdr); err != nil {
			d.mu.Lock()
			running := d.running
			d.mu.Unlock()
			if running {
				log.Printf("[SoundModem] AGW read header: %v", err)
			}
			return
		}
		port := hdr[0]
		kind := hdr[4]
		dataLen := binary.LittleEndian.Uint32(hdr[28:32])

		var data []byte
		if dataLen > 0 {
			if dataLen > 65536 {
				drain := make([]byte, dataLen)
				_, _ = io.ReadFull(conn, drain)
				continue
			}
			data = make([]byte, dataLen)
			if _, err := io.ReadFull(conn, data); err != nil {
				d.mu.Lock()
				running := d.running
				d.mu.Unlock()
				if running {
					log.Printf("[SoundModem] AGW read data: %v", err)
				}
				return
			}
		}

		switch kind {
		case agwKindMonitorUI, agwKindMonitorI, agwKindMonitorS:
			if len(data) > 0 {
				select {
				case resultChan <- smEncodeDCDFrame(port, 1):
				default:
				}
				select {
				case resultChan <- smEncodeMonitorFrame(port, 0, data):
				default:
				}
			}
		case agwKindMonitorT:
			if len(data) > 0 {
				select {
				case resultChan <- smEncodeMonitorFrame(port, 1, data):
				default:
				}
			}
		}
	}
}

func (d *SoundModemDecoder) stderrReadLoop(r io.Reader, resultChan chan<- []byte) {
	defer d.wg.Done()
	scanner := bufio.NewScanner(r)
	for scanner.Scan() {
		select {
		case resultChan <- smEncodeLogFrame(scanner.Text()):
		default:
		}
	}
}

// ---------------------------------------------------------------------------
// Wire-protocol frame encoders
// ---------------------------------------------------------------------------

func smEncodePacketFrame(kissPort byte, ax25 []byte, snr float32) []byte {
	buf := make([]byte, 10+len(ax25))
	buf[0] = MsgPacket
	buf[1] = kissPort
	binary.LittleEndian.PutUint32(buf[2:6], math.Float32bits(snr))
	binary.BigEndian.PutUint32(buf[6:10], uint32(len(ax25)))
	copy(buf[10:], ax25)
	return buf
}

func smEncodeErrorFrame(msg string) []byte {
	b := []byte(msg)
	buf := make([]byte, 5+len(b))
	buf[0] = MsgError
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(b)))
	copy(buf[5:], b)
	return buf
}

func smEncodeDCDFrame(channel, dcdOn byte) []byte {
	return []byte{MsgDCD, channel, dcdOn}
}

func smEncodeMonitorFrame(channel, isTX byte, text []byte) []byte {
	buf := make([]byte, 7+len(text))
	buf[0] = MsgMonitor
	buf[1] = channel
	buf[2] = isTX
	binary.BigEndian.PutUint32(buf[3:7], uint32(len(text)))
	copy(buf[7:], text)
	return buf
}

func smEncodeLogFrame(line string) []byte {
	b := []byte(line)
	buf := make([]byte, 5+len(b))
	buf[0] = MsgLog
	binary.BigEndian.PutUint32(buf[1:5], uint32(len(b)))
	copy(buf[5:], b)
	return buf
}
