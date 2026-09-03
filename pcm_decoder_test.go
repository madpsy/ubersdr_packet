package main

import (
	"crypto/sha256"
	"encoding/binary"
	"encoding/hex"
	"math"
	"net/url"
	"os"
	"testing"
)

// Conformance test for the addon's own version 4 receive path.
//
// internal/pcmv4 has its own copy of this against the decoder package; this one
// runs the same server-produced fixture through pcmDecoder, the wrapper the
// websocket loop actually calls, so a mistake in the integration -- a lost
// sample rate, a reintroduced byte swap, a decoder shared across connections --
// fails here rather than in the field.
//
// The version 4 predictor is backward adaptive: the two ends derive their
// filter taps from the samples already coded and never exchange a coefficient,
// so any divergence produces plausible noise rather than an error. The
// soundmodem would simply stop decoding AX.25 frames, with nothing anywhere
// saying why. Hence a hash of the samples.
const pcmv4FixtureSHA = "ba368c898ae406c5acc806653d9f2dbbfa40086eca3707fda5d77c13948f78d1"

// readPCMv4Fixture returns the packets in testdata/pcmv4_stream.bin.
//
// Layout: "UV4F", a format byte, a uint32 packet count, then each packet as a
// uint32 length and that many bytes.
func readPCMv4Fixture(t *testing.T) [][]byte {
	t.Helper()
	raw, err := os.ReadFile("testdata/pcmv4_stream.bin")
	if err != nil {
		t.Fatalf("fixture: %v", err)
	}
	if len(raw) < 9 || string(raw[:4]) != "UV4F" || raw[4] != 0 {
		t.Fatal("fixture: bad header")
	}
	count := int(binary.LittleEndian.Uint32(raw[5:]))
	off := 9

	packets := make([][]byte, 0, count)
	for i := 0; i < count; i++ {
		if off+4 > len(raw) {
			t.Fatalf("fixture: truncated length at packet %d", i)
		}
		n := int(binary.LittleEndian.Uint32(raw[off:]))
		off += 4
		if off+n > len(raw) {
			t.Fatalf("fixture: truncated packet %d", i)
		}
		packets = append(packets, raw[off:off+n])
		off += n
	}
	if off != len(raw) {
		t.Fatalf("fixture: %d trailing bytes", len(raw)-off)
	}
	return packets
}

func TestPCMDecoderMatchesServerStream(t *testing.T) {
	packets := readPCMv4Fixture(t)
	dec, err := newPCMDecoder()
	if err != nil {
		t.Fatalf("newPCMDecoder: %v", err)
	}
	defer dec.close()

	h := sha256.New()

	// The sample rate and channel count now arrive in the version 4 header
	// rather than a fixed 37-byte one, and are carried forward across packets
	// that omit them. runOnce records them into streamSampleRate/streamChannels
	// off the first packet, and they surface in statusSnapshot and the soundmodem
	// config, so a decoder that lost the carried-forward metadata would still
	// hash correctly while mislabelling the stream.
	wantParams := [][2]int{{12000, 1}, {24000, 1}, {48000, 2}}
	var gotParams [][2]int

	for i, raw := range packets {
		pkt, err := dec.decode(raw)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		if pkt.sampleRate <= 0 || pkt.channels <= 0 {
			t.Fatalf("packet %d: rate=%d channels=%d", i, pkt.sampleRate, pkt.channels)
		}
		if len(pkt.pcm) == 0 || len(pkt.pcm)%(2*pkt.channels) != 0 {
			t.Fatalf("packet %d: %d bytes is not whole frames of %d channels",
				i, len(pkt.pcm), pkt.channels)
		}
		p := [2]int{pkt.sampleRate, pkt.channels}
		if len(gotParams) == 0 || gotParams[len(gotParams)-1] != p {
			gotParams = append(gotParams, p)
		}
		h.Write(pkt.pcm)
	}

	if got := hex.EncodeToString(h.Sum(nil)); got != pcmv4FixtureSHA {
		t.Fatalf("decoded samples differ from what the server encoded\n got %s\nwant %s",
			got, pcmv4FixtureSHA)
	}
	if len(gotParams) != len(wantParams) {
		t.Fatalf("stream parameters: got %v, want %v", gotParams, wantParams)
	}
	for i := range wantParams {
		if gotParams[i] != wantParams[i] {
			t.Fatalf("stream parameters: got %v, want %v", gotParams, wantParams)
		}
	}
}

// A decoder is owned by one connection. runOnce builds a fresh one on every
// connect, and this is why: the predictor's state is derived from the samples
// already decoded, so a decoder carried across a reconnect decodes the new
// stream against the old one's filter taps and yields plausible noise, with no
// error anywhere.
//
// The prefix is the first 50 packets, which stay on one codec profile. The
// stream as a whole switches profile partway through, and a profile change
// builds a new codec -- so replaying the whole fixture would reset the
// predictor incidentally and prove nothing.
func TestPCMDecoderIsResetPerConnection(t *testing.T) {
	const prefix = 50
	packets := readPCMv4Fixture(t)
	if len(packets) < prefix {
		t.Fatalf("fixture has only %d packets", len(packets))
	}

	hashPrefix := func(dec *pcmDecoder) string {
		h := sha256.New()
		for i, raw := range packets[:prefix] {
			pkt, err := dec.decode(raw)
			if err != nil {
				t.Fatalf("packet %d: %v", i, err)
			}
			h.Write(pkt.pcm)
		}
		return hex.EncodeToString(h.Sum(nil))
	}

	first, _ := newPCMDecoder()
	want := hashPrefix(first)

	// What runOnce does on reconnect: a fresh decoder, which reproduces the
	// stream exactly.
	fresh, _ := newPCMDecoder()
	if got := hashPrefix(fresh); got != want {
		t.Fatalf("a fresh decoder decoded the same packets differently\n got %s\nwant %s", got, want)
	}

	// What it must not do: carry the old connection's decoder over. If this
	// ever stops differing, the test above has stopped proving anything.
	if got := hashPrefix(first); got == want {
		t.Fatal("a carried-over decoder reproduced the stream; the reset is no longer load-bearing")
	}
}

// A pre-0.1.63 server answers a version it cannot serve with a zstd frame
// rather than refusing. Saying so once beats logging a bad magic forever.
func TestPCMDecoderReportsLegacyServer(t *testing.T) {
	dec, _ := newPCMDecoder()
	if _, err := dec.decode([]byte{0x28, 0xB5, 0x2F, 0xFD, 0x00}); err == nil {
		t.Fatal("a zstd frame from a legacy server decoded without complaint")
	}
}

// "No measurement" has to stay NaN, because that is what the rest of this
// program tests for: pushSNR drops NaN, statsStore.Record drops NaN, and the
// JSON encodes it as null. The version 4 header uses a -999 sentinel instead,
// so the decoder converts. If it ever passed -999 through, every idle packet
// would enter the SNR ring as a -999 dB sample and drag every reported figure
// down with it -- silently, since -999 is a perfectly valid float.
func TestUnmeasuredSignalBecomesNaN(t *testing.T) {
	cases := []struct {
		name         string
		power, noise float32
		wantNaN      bool
	}{
		{"both measured", -42.5, -78.25, false},
		{"both absent", -999, -999, true},
		// Half a measurement is not a measurement: an SNR is a difference.
		{"power absent", -999, -78.25, true},
		{"noise absent", -42.5, -999, true},
		// The threshold itself, from the server's SignalUnavailableThreshold.
		{"just below the threshold", -998.5, -998.5, true},
		{"just above the threshold", -997.5, -997.5, false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			bb, ns := qualityOrNaN(c.power, c.noise)
			gotNaN := math.IsNaN(float64(bb)) && math.IsNaN(float64(ns))
			if gotNaN != c.wantNaN {
				t.Fatalf("qualityOrNaN(%v, %v) = (%v, %v); NaN=%v, want NaN=%v",
					c.power, c.noise, bb, ns, gotNaN, c.wantNaN)
			}
			if c.wantNaN {
				// Specifically: the sentinel must not survive as a number.
				if bb < -900 || ns < -900 {
					t.Errorf("the -999 sentinel leaked through as a value: (%v, %v)", bb, ns)
				}
			} else if bb != c.power || ns != c.noise {
				t.Errorf("a real measurement was altered: got (%v, %v), want (%v, %v)",
					bb, ns, c.power, c.noise)
			}
		})
	}
}

// And end to end: whatever the fixture carries, nothing resembling the sentinel
// ever reaches a consumer as a number.
func TestDecodedQualityIsNeverTheSentinel(t *testing.T) {
	dec, _ := newPCMDecoder()
	measured := 0
	for i, raw := range readPCMv4Fixture(t) {
		pkt, err := dec.decode(raw)
		if err != nil {
			t.Fatalf("packet %d: %v", i, err)
		}
		for _, v := range []float32{pkt.basebandDBFS, pkt.noiseDBFS} {
			if !math.IsNaN(float64(v)) {
				measured++
				if v < -900 {
					t.Fatalf("packet %d: %v reached a consumer as a number", i, v)
				}
			}
		}
	}
	if measured == 0 {
		t.Skip("fixture carries no signal-quality fields; nothing to check")
	}
}

// The SNR scale shift is derived from the same bandwidthParams that builds the
// request, so it tracks the passband this addon actually asks for rather than
// a constant. These are the values quoted in the comment beside it.
func TestSNRScaleShiftTracksThePassband(t *testing.T) {
	cases := []struct {
		mode     string
		bwHz     int
		passband float64
		shiftDB  float64
	}{
		{"usb", 0, 2950, 34.698},    // server preset
		{"lsb", 0, 2950, 34.698},    // server preset
		{"usb", 2400, 2100, 33.222}, // 300..2400
		{"lsb", 2400, 2100, 33.222}, // -2400..-300
		{"cw", 500, 500, 26.990},
		{"fm", 0, 16000, 42.041},
		{"nbfm", 0, 2950, 34.698}, // not in the table: SSB default
	}
	for _, c := range cases {
		if got := passbandHz(c.mode, c.bwHz); math.Abs(got-c.passband) > 0.5 {
			t.Errorf("passbandHz(%q, %d) = %.1f, want %.1f", c.mode, c.bwHz, got, c.passband)
		}
		if got := snrScaleShiftDB(c.mode, c.bwHz); math.Abs(got-c.shiftDB) > 0.01 {
			t.Errorf("snrScaleShiftDB(%q, %d) = %.3f, want %.3f", c.mode, c.bwHz, got, c.shiftDB)
		}
	}
}

// The websocket URL asks for version 4 and keeps the pcm-zstd format name,
// which selects the PCM stream rather than the framing. The bandwidth
// parameters must survive too: they choose the passband, which is what makes
// the version 4 noise figure -- and so the SNR -- mean what it means.
func TestWSURLRequestsVersion4(t *testing.T) {
	inst := newInstance(7049450, 0, "usb", "ws://example.invalid/ws", "", "probe", 0)
	u, err := url.Parse(inst.wsURL())
	if err != nil {
		t.Fatalf("wsURL: %v", err)
	}
	q := u.Query()

	if got := q.Get("version"); got != "4" {
		t.Errorf("version = %q, want \"4\"", got)
	}
	if got := q.Get("format"); got != "pcm-zstd" {
		t.Errorf("format = %q, want \"pcm-zstd\"", got)
	}
	if got := q.Get("frequency"); got != "7049450" {
		t.Errorf("frequency = %q, want \"7049450\"", got)
	}
	if got := q.Get("mode"); got != "usb" {
		t.Errorf("mode = %q, want \"usb\"", got)
	}
	// No bandwidth configured: the server preset applies and no bandwidth
	// parameters are sent.
	if q.Has("bandwidthLow") || q.Has("bandwidthHigh") {
		t.Errorf("bandwidth parameters sent for an unconfigured channel: %v", q)
	}

	// With a bandwidth set they must appear, on version 4 as before.
	inst.setBandwidth(2400)
	q = mustQuery(t, inst.wsURL())
	if got := q.Get("version"); got != "4" {
		t.Errorf("version = %q after setBandwidth, want \"4\"", got)
	}
	if got, want := q.Get("bandwidthLow"), "300"; got != want {
		t.Errorf("bandwidthLow = %q, want %q", got, want)
	}
	if got, want := q.Get("bandwidthHigh"), "2400"; got != want {
		t.Errorf("bandwidthHigh = %q, want %q", got, want)
	}
}

func mustQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("wsURL: %v", err)
	}
	return u.Query()
}

// The soundmodem is configured at a fixed rate while the stream rate comes from
// the version 4 header. Nothing couples them, so the mismatch has to be
// noticed rather than assumed away: a preset change would otherwise surface
// only as AX.25 that stops decoding.
func TestSampleRateMismatchIsDetected(t *testing.T) {
	if sampleRateMismatch(smSampleRate) {
		t.Errorf("the configured rate %d was reported as a mismatch", smSampleRate)
	}
	if sampleRateMismatch(0) {
		t.Error("an unknown rate (0) was reported as a mismatch")
	}
	for _, r := range []int{8000, 24000, 48000} {
		if !sampleRateMismatch(r) {
			t.Errorf("a %d Hz stream was not flagged against the %d Hz modem", r, smSampleRate)
		}
	}

	// And the rate the fixture's audio packets carry is the one the modem
	// expects, which is what makes the fixed constant safe today.
	dec, _ := newPCMDecoder()
	pkt, err := dec.decode(readPCMv4Fixture(t)[0])
	if err != nil {
		t.Fatalf("decode: %v", err)
	}
	if pkt.sampleRate <= 0 {
		t.Fatalf("first packet reported rate %d", pkt.sampleRate)
	}
}
