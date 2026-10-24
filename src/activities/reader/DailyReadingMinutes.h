#pragma once
#include <array>
#include <cstddef>
#include <cstdint>

#include "ReadingStatsUtils.h"

// Local per-day reading time for the recent past, persisted to
// /.crosspoint/daily_reading.bin. Kept separate from global_stats.bin so that
// file's format (shared with Nearby stats sync and backups) stays unchanged.
//
// Layout (version 1, little-endian):
//   [0]      version (= 1)
//   [1..4]   anchorDay: readingStatsDayIndex() of seconds[0]
//   [5..]    DAYS x uint32 seconds; index k is anchorDay - k
//
// About 760 bytes, so hold instances on the heap (makeUniqueNoThrow) rather
// than on a task stack.
struct DailyReadingMinutes {
  static constexpr size_t DAYS = 189;  // 27 weeks

  uint32_t anchorDay = 0;  // 0 means no reading has been recorded yet
  std::array<uint32_t, DAYS> seconds{};

  bool empty() const { return anchorDay == 0; }

  // Seconds read on dayIndex, or 0 when it is outside the stored window.
  uint32_t secondsForDay(uint32_t dayIndex) const;

  // Adds seconds to one day, sliding the window forward for a newer day.
  void addDaySeconds(uint32_t dayIndex, uint32_t secondsToAdd);

  // Splits a reading span at local midnight and adds each part to its day.
  void recordSpan(const ReadingStatsDateTime& localStart, uint32_t spanSeconds);

  // Loads /.crosspoint/daily_reading.bin. Leaves out empty and returns false
  // when the file is missing or invalid.
  static bool load(DailyReadingMinutes& out);

  // Writes /.crosspoint/daily_reading.bin through a .tmp file.
  bool save() const;

  // Loads the log, records one finished reading span, and saves it.
  static bool addSpan(const ReadingStatsDateTime& localStart, uint32_t spanSeconds);

  // Records one finished reader session with the same rule commitReadingSession
  // uses for reading time: at least 10 seconds and a known local start time.
  static void recordSession(uint32_t sessionSeconds, const ReadingStatsDateTime* sessionStart);

  // Deletes the log. A missing file counts as success.
  static bool reset();
};
