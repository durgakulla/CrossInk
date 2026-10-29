#pragma once

#include <array>
#include <cstdint>
#include <string>

#include "ReadingStatsUtils.h"

struct BookReadingStats;

// Chapter ticks closer than this (in thousandths of the book, about 4px on a
// 300px bar) are merged into the previous one.
constexpr int kBookProgressMinChapterTickPermille = 13;

// A book's numbers for the detailed progress bar shown under its cover on the
// Reading Heatmap sleep screen and the Minimal Carousel home screen.
struct BookProgressDetails {
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

// Fills details for the book at path from its reading stats and progress
// percent. now (may be null without a clock) dates the estimated finish.
// Reads the book's cache from the SD card: for EPUBs the table of contents,
// the saved position and stable page numbers; for XTC books the saved page.
void loadBookProgressDetails(const std::string& path, const BookReadingStats& stats, float progressPercent,
                             const ReadingStatsDateTime* now, BookProgressDetails& details);
