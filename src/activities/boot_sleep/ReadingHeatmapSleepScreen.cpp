#include "ReadingHeatmapSleepScreen.h"

#include <Bitmap.h>
#include <GfxRenderer.h>
#include <HalStorage.h>
#include <I18n.h>

#include <algorithm>
#include <cstdio>
#include <iterator>
#include <numeric>

#include "activities/reader/DailyReadingMinutes.h"
#include "activities/reader/GlobalReadingStats.h"
#include "fontIds.h"

namespace {
constexpr int kMonths = 5;
constexpr int kDaysPerWeek = 7;
constexpr int kMaxPitch = 20;
// Below this the cells get too small for the weekday labels, so the cover
// shrinks instead.
constexpr int kMinPitch = 13;
constexpr int kSideInset = 10;
constexpr int kMonthGap = 8;
constexpr int kWeekdayLabelGap = 10;
constexpr int kTopInset = 14;
constexpr int kBottomInset = 16;
constexpr int kCoverGap = 18;
constexpr int kSectionGap = 20;
constexpr uint32_t kMediumDaySeconds = 15U * 60U;
constexpr uint32_t kHeavyDaySeconds = 45U * 60U;

static_assert(kMonths * 31 <= static_cast<int>(DailyReadingMinutes::DAYS),
              "The per-day log must cover every heatmap cell");

// One calendar block: a column per Monday-based week the month touches.
struct MonthBlock {
  ReadingStatsDate first;
  uint32_t firstDayIndex;
  uint8_t days;
  uint8_t firstWeekday;  // Monday = 0
  int columns;
  int x;
};

// 0 = not read, 1 = light (or minutes unknown), 2 = medium, 3 = heavy.
uint8_t shadeLevelFor(const bool read, const uint32_t seconds) {
  if (!read && seconds == 0) return 0;
  if (seconds >= kHeavyDaySeconds) return 3;
  if (seconds >= kMediumDaySeconds) return 2;
  return 1;
}

// Every other pixel, so empty days read as a faint gray outline.
void drawDottedRect(const GfxRenderer& renderer, const int x, const int y, const int size) {
  const int last = size - 1;
  for (int i = 0; i < size; i += 2) {
    renderer.drawPixel(x + i, y);
    renderer.drawPixel(x + i, y + last);
    renderer.drawPixel(x, y + i);
    renderer.drawPixel(x + last, y + i);
  }
}

void drawCell(const GfxRenderer& renderer, const int x, const int y, const int size, const uint8_t level) {
  switch (level) {
    case 3:
      renderer.fillRect(x, y, size, size, true);
      return;
    case 2:
      renderer.fillRectDither(x, y, size, size, Color::DarkGray);
      return;
    case 1:
      renderer.fillRectDither(x, y, size, size, Color::LightGray);
      return;
    default:
      drawDottedRect(renderer, x, y, size);
      return;
  }
}

bool readCoverSize(const char* coverBmpPath, int& width, int& height) {
  if (!coverBmpPath || coverBmpPath[0] == '\0') return false;
  FsFile file;
  if (!Storage.openFileForRead("SLP", coverBmpPath, file)) return false;
  Bitmap bitmap(file);
  const bool ok = bitmap.parseHeaders() == BmpReaderError::Ok && bitmap.getWidth() > 0 && bitmap.getHeight() > 0;
  if (ok) {
    width = bitmap.getWidth();
    height = bitmap.getHeight();
  }
  file.close();
  return ok;
}

// Draws the cover scaled to fit the box, centered horizontally and moved down
// by half the unused height so the cover and heatmap sit centered together.
// Returns the cover's bottom edge, or 0 if nothing was drawn.
int drawCover(const GfxRenderer& renderer, const char* coverBmpPath, const int boxX, const int boxY, const int boxW,
              const int boxH) {
  if (!coverBmpPath || coverBmpPath[0] == '\0' || boxW <= 0 || boxH <= 0) return 0;
  FsFile file;
  if (!Storage.openFileForRead("SLP", coverBmpPath, file)) return 0;
  int bottom = 0;
  Bitmap bitmap(file);
  if (bitmap.parseHeaders() == BmpReaderError::Ok && bitmap.getWidth() > 0 && bitmap.getHeight() > 0) {
    const float scale = std::min({1.0f, static_cast<float>(boxW) / static_cast<float>(bitmap.getWidth()),
                                  static_cast<float>(boxH) / static_cast<float>(bitmap.getHeight())});
    const int drawnW = std::max(1, static_cast<int>(bitmap.getWidth() * scale));
    const int drawnH = std::max(1, static_cast<int>(bitmap.getHeight() * scale));
    const int x = boxX + (boxW - drawnW) / 2;
    const int y = boxY + (boxH - drawnH) / 2;
    if (renderer.drawBitmap(bitmap, x, y, drawnW, drawnH)) {
      renderer.drawRect(x, y, drawnW, drawnH, true);
      bottom = y + drawnH;
    }
  }
  file.close();
  return bottom;
}

void formatDayCount(const uint16_t days, char* buf, const size_t len) {
  if (days == 0) {
    snprintf(buf, len, "-");
    return;
  }
  snprintf(buf, len, "%u %s", static_cast<unsigned>(days), days == 1 ? tr(STR_STATS_DAY) : tr(STR_STATS_DAYS));
}

void formatDuration(const uint32_t seconds, char* buf, const size_t len) {
  if (seconds == 0) {
    snprintf(buf, len, "-");
    return;
  }
  // Minutes stop mattering past 100 hours, and dropping them keeps the column narrow.
  if (seconds >= 100U * 3600U) {
    snprintf(buf, len, "%uh", static_cast<unsigned>(seconds / 3600U));
    return;
  }
  formatCompactReadingDuration(seconds, buf, len);
}

void drawStatColumn(const GfxRenderer& renderer, const int centerX, const int y, const char* value, const char* label) {
  const int valueWidth = renderer.getTextWidth(UI_10_FONT_ID, value, EpdFontFamily::BOLD);
  renderer.drawText(UI_10_FONT_ID, centerX - valueWidth / 2, y, value, true, EpdFontFamily::BOLD);
  const int labelY = y + renderer.getLineHeight(UI_10_FONT_ID) + 2;
  const int labelWidth = renderer.getTextWidth(SMALL_FONT_ID, label);
  renderer.drawText(SMALL_FONT_ID, centerX - labelWidth / 2, labelY, label);
}
}  // namespace

void drawReadingHeatmapSleepScreen(const GfxRenderer& renderer, const GlobalReadingStats& globalStats,
                                   const DailyReadingMinutes* dailyMinutes, const ReadingStatsDate& today,
                                   const char* coverBmpPath, const bool inverted) {
  const int screenWidth = renderer.getScreenWidth();
  const int screenHeight = renderer.getScreenHeight();
  int viewTop = 0, viewRight = 0, viewBottom = 0, viewLeft = 0;
  renderer.getOrientedViewableTRBL(&viewTop, &viewRight, &viewBottom, &viewLeft);
  const int left = viewLeft + kSideInset;
  const int right = screenWidth - viewRight - kSideInset;
  const int usableWidth = right - left;

  const int smallLineHeight = renderer.getLineHeight(SMALL_FONT_ID);
  const int statsHeight = renderer.getLineHeight(UI_10_FONT_ID) + 2 + smallLineHeight;

  const char* const weekdayLabels[kDaysPerWeek] = {tr(STR_HEATMAP_MO), tr(STR_HEATMAP_TU), tr(STR_HEATMAP_WE),
                                                   tr(STR_HEATMAP_TH), tr(STR_HEATMAP_FR), tr(STR_HEATMAP_SA),
                                                   tr(STR_HEATMAP_SU)};
  const int maxWeekdayLabelWidth = std::accumulate(
      std::begin(weekdayLabels), std::end(weekdayLabels), 0, [&renderer](const int widest, const char* label) {
        return std::max(widest, renderer.getTextWidth(SMALL_FONT_ID, label));
      });
  const int labelColumnWidth = maxWeekdayLabelWidth + kWeekdayLabelGap;

  // Oldest month first, ending with the current month.
  MonthBlock months[kMonths];
  int totalColumns = 0;
  ReadingStatsDate monthStart{today.year, today.month, 1};
  for (int i = kMonths - 1; i >= 0; --i) {
    MonthBlock& block = months[i];
    block.first = monthStart;
    block.firstDayIndex = readingStatsDayIndex(monthStart);
    block.days = daysInMonth(monthStart.year, monthStart.month);
    block.firstWeekday = readingStatsDayOfWeekIndex(monthStart);
    // The current month ends at this week so the weekday labels sit beside today.
    const int shownDays = i == kMonths - 1 ? today.day : block.days;
    block.columns = (block.firstWeekday + shownDays + kDaysPerWeek - 1) / kDaysPerWeek;
    totalColumns += block.columns;
    if (monthStart.month == 1) {
      monthStart = {static_cast<uint16_t>(monthStart.year - 1), 12, 1};
    } else {
      monthStart.month--;
    }
  }

  const int monthRowHeight = smallLineHeight + 4;
  const int heatmapHeightWithoutGrid = monthRowHeight + kSectionGap + statsHeight;
  const auto gapForPitch = [](const int cellPitch) { return std::max(3, cellPitch / 5); };

  const int usableTop = viewTop + kTopInset;
  const int usableHeight = screenHeight - viewBottom - kBottomInset - usableTop;

  // Shrinking a dithered cover by even a few pixels drops whole rows and
  // columns, which shows up as faint lines across gray areas. Keep the cover
  // at its native size by making the cells smaller, down to kMinPitch.
  const int gridAreaWidth = usableWidth - labelColumnWidth;
  int pitch = std::clamp((gridAreaWidth - (kMonths - 1) * kMonthGap) / totalColumns, 4, kMaxPitch);
  int coverWidth = 0;
  int coverHeight = 0;
  if (readCoverSize(coverBmpPath, coverWidth, coverHeight) && coverWidth <= usableWidth) {
    const int roomForGrid = usableHeight - coverHeight - kCoverGap - heatmapHeightWithoutGrid;
    while (pitch > kMinPitch && pitch * kDaysPerWeek - gapForPitch(pitch) > roomForGrid) {
      pitch--;
    }
  }
  const int gap = gapForPitch(pitch);
  const int cellSize = pitch - gap;
  const int gridWidth = totalColumns * pitch - gap + (kMonths - 1) * kMonthGap;
  const int gridHeight = pitch * kDaysPerWeek - gap;
  // Weekday labels sit to the right, next to the current month; the grid and
  // labels are centered together.
  const int gridLeft = left + (gridAreaWidth - gridWidth) / 2;
  const int weekdayLabelX = gridLeft + gridWidth + (labelColumnWidth - maxWeekdayLabelWidth);
  int blockX = gridLeft;
  for (MonthBlock& block : months) {
    block.x = blockX;
    blockX += block.columns * pitch + kMonthGap;
  }
  const int heatmapHeight = heatmapHeightWithoutGrid + gridHeight;

  renderer.clearScreen();

  // The cover takes whatever height the heatmap leaves; the pair is centered.
  const int coverBoxHeight = usableHeight - heatmapHeight - kCoverGap;
  const int coverBottom = drawCover(renderer, coverBmpPath, left, usableTop, usableWidth, coverBoxHeight);
  int y = coverBottom > 0 ? coverBottom + kCoverGap : usableTop + std::max(0, (usableHeight - heatmapHeight) / 2);

  const uint32_t todayIndex = readingStatsDayIndex(today);
  const int monthY = y;
  y += monthRowHeight;
  const int gridTop = y;

  for (int row = 0; row < kDaysPerWeek; ++row) {
    const int labelY = gridTop + row * pitch + (cellSize - smallLineHeight) / 2;
    renderer.drawText(SMALL_FONT_ID, weekdayLabelX, labelY, weekdayLabels[row]);
  }

  // Each month is drawn as its own block; days after today stay blank.
  uint32_t monthSeconds = 0;
  for (const MonthBlock& block : months) {
    char monthText[8];
    formatReadingStatsMonthToken(block.first, monthText, sizeof(monthText));
    const int blockWidth = block.columns * pitch - gap;
    renderer.drawText(SMALL_FONT_ID, block.x + (blockWidth - renderer.getTextWidth(SMALL_FONT_ID, monthText)) / 2,
                      monthY, monthText);

    for (int day = 0; day < block.days; ++day) {
      const uint32_t dayIndex = block.firstDayIndex + static_cast<uint32_t>(day);
      if (dayIndex > todayIndex) break;
      const uint32_t seconds = dailyMinutes ? dailyMinutes->secondsForDay(dayIndex) : 0;
      const bool read =
          isReadingHistoryDaySet(globalStats.readingHistoryAnchorDay, globalStats.readingHistoryBits, dayIndex) ||
          seconds > 0;
      const uint8_t level = shadeLevelFor(read, seconds);
      if (&block == &months[kMonths - 1]) monthSeconds += seconds;

      const int slot = block.firstWeekday + day;
      const int x = block.x + (slot / kDaysPerWeek) * pitch;
      const int cellY = gridTop + (slot % kDaysPerWeek) * pitch;
      drawCell(renderer, x, cellY, cellSize, level);
      if (dayIndex == todayIndex) {
        renderer.drawRect(x - 2, cellY - 2, cellSize + 4, cellSize + 4, 2, true);
      }
    }
  }
  y = gridTop + gridHeight + kSectionGap;

  // Stats row: Streak, Longest, All Time, This Month, Today.
  constexpr int kStatCount = 5;
  char values[kStatCount][24];
  formatDayCount(globalStats.currentReadingStreak(&today), values[0], sizeof(values[0]));
  formatDayCount(globalStats.displayLongestReadingStreak(&today), values[1], sizeof(values[1]));
  formatDuration(globalStats.totalReadingSeconds, values[2], sizeof(values[2]));
  formatDuration(monthSeconds, values[3], sizeof(values[3]));
  formatDuration(dailyMinutes ? dailyMinutes->secondsForDay(todayIndex) : 0, values[4], sizeof(values[4]));
  const char* const labels[kStatCount] = {tr(STR_HEATMAP_STREAK), tr(STR_HEATMAP_LONGEST), tr(STR_HEATMAP_ALL_TIME),
                                          tr(STR_HEATMAP_THIS_MONTH), tr(STR_HEATMAP_TODAY)};
  for (int i = 0; i < kStatCount; ++i) {
    drawStatColumn(renderer, left + usableWidth * (2 * i + 1) / (2 * kStatCount), y, values[i], labels[i]);
  }

  if (inverted) {
    renderer.invertScreen();
  }
}
