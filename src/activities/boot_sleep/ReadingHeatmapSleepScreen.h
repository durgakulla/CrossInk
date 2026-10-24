#pragma once

#include "activities/reader/ReadingStatsUtils.h"

class GfxRenderer;
struct DailyReadingMinutes;
struct GlobalReadingStats;

// Draws a reading heatmap of the last 5 months into the frame buffer: one
// calendar block per month, one column per week (Monday at the top), the
// current month last.
// Cells are shaded by minutes read; days marked read in the global history but
// missing from the per-day log use the lightest shade. dailyMinutes may be
// null when the log could not be loaded. coverBmpPath (may be empty) is drawn
// above the heatmap. The caller pushes the buffer.
void drawReadingHeatmapSleepScreen(const GfxRenderer& renderer, const GlobalReadingStats& globalStats,
                                   const DailyReadingMinutes* dailyMinutes, const ReadingStatsDate& today,
                                   const char* coverBmpPath, bool inverted);
