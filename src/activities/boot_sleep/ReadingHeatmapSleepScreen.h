#pragma once

#include <array>

#include "activities/reader/ReadingStatsUtils.h"

class GfxRenderer;
struct DailyReadingMinutes;
struct GlobalReadingStats;

// Chapter ticks closer than this (in thousandths of the book, about 4px on the
// X3's bar) are merged into the previous one.
constexpr int kHeatmapMinChapterTickPermille = 13;

// The current book's numbers shown in the progress bar under its cover.
struct HeatmapBookStats {
  float progressPercent = -1.0f;  // Negative when unknown
  uint32_t page = 0;              // Stable (EPUB) or XTC page, 1-based; 0 when unknown
  uint32_t pageCount = 0;
  uint32_t readingSeconds = 0;              // Time read in this book; 0 when unknown or untracked
  uint32_t pagesTurned = 0;                 // Forward pages read in this book, for the reading pace
  uint32_t timeLeftSeconds = 0;             // Estimated time to finish; 0 when unknown
  uint32_t chapterTimeLeftSeconds = 0;      // Estimated time to finish the chapter; 0 when unknown
  ReadingStatsDate startDate;               // Invalid when unknown
  ReadingStatsDate endDate;                 // Finished date, or the estimated one; invalid when unknown
  bool finished = false;                    // endDate is the actual finished date
  std::array<uint16_t, 64> chapterTicks{};  // Chapter starts, in thousandths of the book
  uint8_t chapterTickCount = 0;
};

// Draws a reading heatmap of the last 5 months into the frame buffer: one
// calendar block per month, one column per week (Monday at the top), the
// current month last.
// Cells are shaded by minutes read; days marked read in the global history but
// missing from the per-day log use the lightest shade. dailyMinutes may be
// null when the log could not be loaded. coverBmpPath (may be empty) is drawn
// above the heatmap, with a progress bar for bookStats (may be null) under it. The
// caller pushes the buffer.
void drawReadingHeatmapSleepScreen(const GfxRenderer& renderer, const GlobalReadingStats& globalStats,
                                   const DailyReadingMinutes* dailyMinutes, const ReadingStatsDate& today,
                                   const char* coverBmpPath, const HeatmapBookStats* bookStats, bool inverted);
