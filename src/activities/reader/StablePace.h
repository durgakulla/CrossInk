#pragma once
#include <cstdint>
#include <string>

struct BookReadingStats;

// Reading pace in stable pages, for books with stable page numbers: the stable
// pages read across counted forward page turns and the seconds spent on them.
// Persisted to cachePath/stable_pace.bin, a sidecar to stats_v5.bin so the
// shared stats format stays as upstream CrossInk defines it.
struct StablePace {
  uint32_t pages = 0;
  uint32_t seconds = 0;
  // The book has stable page numbers (the file exists), so its pace is shown
  // in stable pages; see readingPagesPerMinute().
  bool tracked = false;
  // Stable pace shows once this much reading has been measured.
  static constexpr uint32_t kMinSeconds = 120;

  // Enough stable reading measured to show a pace or time left from it.
  bool ready() const { return tracked && pages > 0 && seconds >= kMinSeconds; }

  // Untracked (default) stats when the file is missing or invalid.
  static StablePace load(const std::string& cachePath);
  // Writes the file (through a .tmp file) and marks the pace tracked.
  bool save(const std::string& cachePath);
  static bool remove(const std::string& cachePath);

  // Adds the stable pages between two counted forward turns.
  void add(uint32_t stablePages, uint32_t turnSeconds);
};

// Pages per minute for a book: stable pages when its pace is tracked (none
// until enough has been measured, so units never mix), otherwise forward page
// turns. False when there is nothing to show yet.
bool readingPagesPerMinute(const BookReadingStats& stats, const StablePace& pace, float& out);
