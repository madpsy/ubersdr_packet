// stats.go — Persistent in-memory statistics accumulator.
//
// statsStore tracks per-(channel, callsign, sm_ch) frame counts and timing
// data that accumulate for the lifetime of the process.  Unlike the 1000-frame
// ring buffer in packetChannel, these counters are never evicted.
//
// REST API:
//
//	GET /api/stats
//	  ?channel=<label>   — filter to one channel (omit for all)
//	  ?callsign=<cs>     — filter to one callsign (case-insensitive exact)
//	  ?sm_ch=<0-3>       — filter to one modem sub-channel
//
// Response: JSON array of statEntry objects (see below).
package main

import (
	"math"
	"sort"
	"strings"
	"sync"
	"time"
)

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

// statKey uniquely identifies one (channel, callsign, sm_ch) combination.
type statKey struct {
	channel  string
	callsign string
	smCh     int
}

// hourBucket tracks frame counts for each hour of the day (UTC, 0–23).
type hourBucket [24]int

// statEntry is the accumulated statistics for one statKey.
type statEntry struct {
	mu sync.Mutex

	Channel  string `json:"channel"`
	Callsign string `json:"callsign"`
	SmCh     int    `json:"sm_ch"`

	TotalFrames int       `json:"total_frames"`
	FirstSeen   time.Time `json:"first_seen"`
	LastSeen    time.Time `json:"last_seen"`

	// SNR statistics (only populated when SNR data is available)
	SNRCount int     `json:"snr_count"`
	SNRSum   float64 `json:"snr_sum"` // for computing mean
	SNRMin   float32 `json:"snr_min"`
	SNRMax   float32 `json:"snr_max"`
	SNRMean  float32 `json:"snr_mean"` // computed on read

	// FramesPerDay: UTC date string "2006-01-02" → count
	FramesPerDay map[string]int `json:"frames_per_day"`

	// FramesPerHour: hour of day (UTC, 0–23) → count
	FramesPerHour [24]int `json:"frames_per_hour"`

	// FrameTypes: frame_type string → count
	FrameTypes map[string]int `json:"frame_types"`

	// TopDestinations: destination callsign → count (top 20 kept)
	TopDestinations map[string]int `json:"top_destinations"`
}

// snapshot returns a copy of the entry safe for JSON serialisation.
func (e *statEntry) snapshot() statEntry {
	e.mu.Lock()
	defer e.mu.Unlock()

	// Compute mean SNR
	snrMean := float32(math.NaN())
	if e.SNRCount > 0 {
		snrMean = float32(e.SNRSum / float64(e.SNRCount))
	}

	// Deep-copy maps
	fpd := make(map[string]int, len(e.FramesPerDay))
	for k, v := range e.FramesPerDay {
		fpd[k] = v
	}
	ft := make(map[string]int, len(e.FrameTypes))
	for k, v := range e.FrameTypes {
		ft[k] = v
	}
	td := make(map[string]int, len(e.TopDestinations))
	for k, v := range e.TopDestinations {
		td[k] = v
	}

	return statEntry{
		Channel:         e.Channel,
		Callsign:        e.Callsign,
		SmCh:            e.SmCh,
		TotalFrames:     e.TotalFrames,
		FirstSeen:       e.FirstSeen,
		LastSeen:        e.LastSeen,
		SNRCount:        e.SNRCount,
		SNRSum:          e.SNRSum,
		SNRMin:          e.SNRMin,
		SNRMax:          e.SNRMax,
		SNRMean:         snrMean,
		FramesPerDay:    fpd,
		FramesPerHour:   e.FramesPerHour,
		FrameTypes:      ft,
		TopDestinations: td,
	}
}

// ---------------------------------------------------------------------------
// statsStore
// ---------------------------------------------------------------------------

// statsStore is the global accumulator.  All methods are safe for concurrent use.
type statsStore struct {
	mu      sync.RWMutex
	entries map[statKey]*statEntry
}

func newStatsStore() *statsStore {
	return &statsStore{
		entries: make(map[statKey]*statEntry),
	}
}

// Record accumulates statistics for one decoded frame.
func (s *statsStore) Record(channel, callsign, destination, frameType string, smCh int, snr *float32, receivedAt time.Time) {
	if callsign == "" {
		return
	}
	key := statKey{channel: channel, callsign: callsign, smCh: smCh}

	s.mu.RLock()
	e := s.entries[key]
	s.mu.RUnlock()

	if e == nil {
		s.mu.Lock()
		// Double-check after acquiring write lock
		e = s.entries[key]
		if e == nil {
			e = &statEntry{
				Channel:         channel,
				Callsign:        callsign,
				SmCh:            smCh,
				FirstSeen:       receivedAt,
				SNRMin:          float32(math.Inf(1)),
				SNRMax:          float32(math.Inf(-1)),
				FramesPerDay:    make(map[string]int),
				FrameTypes:      make(map[string]int),
				TopDestinations: make(map[string]int),
			}
			s.entries[key] = e
		}
		s.mu.Unlock()
	}

	e.mu.Lock()
	defer e.mu.Unlock()

	e.TotalFrames++
	if receivedAt.After(e.LastSeen) {
		e.LastSeen = receivedAt
	}
	if receivedAt.Before(e.FirstSeen) {
		e.FirstSeen = receivedAt
	}

	// SNR
	if snr != nil && !math.IsNaN(float64(*snr)) {
		e.SNRCount++
		e.SNRSum += float64(*snr)
		if *snr < e.SNRMin {
			e.SNRMin = *snr
		}
		if *snr > e.SNRMax {
			e.SNRMax = *snr
		}
	}

	// Per-day (UTC)
	dayKey := receivedAt.UTC().Format("2006-01-02")
	e.FramesPerDay[dayKey]++

	// Per-hour-of-day (UTC)
	hour := receivedAt.UTC().Hour()
	e.FramesPerHour[hour]++

	// Frame type
	if frameType != "" {
		e.FrameTypes[frameType]++
	}

	// Destination (keep top 50 by count; trim to 50 when over 60)
	if destination != "" {
		e.TopDestinations[destination]++
		if len(e.TopDestinations) > 60 {
			s.trimDestinations(e)
		}
	}
}

// trimDestinations removes the lowest-count destinations, keeping the top 50.
// Must be called with e.mu held.
func (s *statsStore) trimDestinations(e *statEntry) {
	type kv struct {
		k string
		v int
	}
	pairs := make([]kv, 0, len(e.TopDestinations))
	for k, v := range e.TopDestinations {
		pairs = append(pairs, kv{k, v})
	}
	sort.Slice(pairs, func(i, j int) bool { return pairs[i].v > pairs[j].v })
	newMap := make(map[string]int, 50)
	for i := 0; i < 50 && i < len(pairs); i++ {
		newMap[pairs[i].k] = pairs[i].v
	}
	e.TopDestinations = newMap
}

// Query returns a filtered, sorted snapshot of all stat entries.
// channel, callsign, smCh are optional filters (empty string / -1 = no filter).
func (s *statsStore) Query(channel, callsign string, smCh int) []statEntry {
	callsignLower := strings.ToLower(callsign)

	s.mu.RLock()
	keys := make([]statKey, 0, len(s.entries))
	for k := range s.entries {
		if channel != "" && k.channel != channel {
			continue
		}
		if callsign != "" && strings.ToLower(k.callsign) != callsignLower {
			continue
		}
		if smCh >= 0 && k.smCh != smCh {
			continue
		}
		keys = append(keys, k)
	}
	s.mu.RUnlock()

	result := make([]statEntry, 0, len(keys))
	s.mu.RLock()
	for _, k := range keys {
		if e := s.entries[k]; e != nil {
			result = append(result, e.snapshot())
		}
	}
	s.mu.RUnlock()

	// Sort by total_frames descending, then callsign asc
	sort.Slice(result, func(i, j int) bool {
		if result[i].TotalFrames != result[j].TotalFrames {
			return result[i].TotalFrames > result[j].TotalFrames
		}
		return result[i].Callsign < result[j].Callsign
	})
	return result
}

// ---------------------------------------------------------------------------
// Global instance (wired up in main)
// ---------------------------------------------------------------------------

var globalStats = newStatsStore()
