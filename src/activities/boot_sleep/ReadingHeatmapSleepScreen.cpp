#include "ReadingHeatmapSleepScreen.h"

#include <Bitmap.h>
#include <GfxRenderer.h>
#include <HalStorage.h>
#include <I18n.h>

#include <algorithm>
#include <cstdio>
#include <iterator>
#include <numeric>

#include "CrossPointSettings.h"
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
constexpr int kTopInset = 8;
constexpr int kBottomInset = 16;
constexpr int kCoverGap = 12;
constexpr int kSectionGap = 16;
// Header: the date the device went to sleep, centered, with a moon at the right.
constexpr int kHeaderGap = 6;
constexpr int kMoonSize = 14;
// Book progress footer under the cover, laid out like the carousel's.
constexpr int kProgressLabelToBarGap = 3;
constexpr int kProgressBarHeight = 7;
constexpr int kProgressBarToLabelGap = 2;
// Stacks the lines of a date beside the bar closer together; small-font lines
// have spare leading.
constexpr int kDateLineOverlap = 4;
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
// Returns whether it was drawn; outX/outY/outW/outH receive its bounds.
bool drawCover(const GfxRenderer& renderer, const char* coverBmpPath, const int boxX, const int boxY, const int boxW,
               const int boxH, int& outX, int& outY, int& outW, int& outH) {
  if (!coverBmpPath || coverBmpPath[0] == '\0' || boxW <= 0 || boxH <= 0) return false;
  FsFile file;
  if (!Storage.openFileForRead("SLP", coverBmpPath, file)) return false;
  bool drawn = false;
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
      outX = x;
      outY = y;
      outW = drawnW;
      outH = drawnH;
      drawn = true;
    }
  }
  file.close();
  return drawn;
}

// Current streak with the best streak in brackets, e.g. "11d (14d)".
void formatStreak(const uint16_t current, const uint16_t best, char* buf, const size_t len) {
  if (current == 0 && best == 0) {
    snprintf(buf, len, "-");
    return;
  }
  snprintf(buf, len, "%ud (%ud)", static_cast<unsigned>(current), static_cast<unsigned>(best));
}

// From wholeHoursFrom hours up, minutes are dropped to keep the column narrow.
void formatDuration(const uint32_t seconds, char* buf, const size_t len, const uint32_t wholeHoursFrom = 100) {
  if (seconds == 0) {
    snprintf(buf, len, "-");
    return;
  }
  if (seconds >= wholeHoursFrom * 3600U) {
    snprintf(buf, len, "%uh", static_cast<unsigned>(seconds / 3600U));
    return;
  }
  formatCompactReadingDuration(seconds, buf, len);
}

void formatPercent(const float percent, char* buf, const size_t len) {
  if (percent < 0.0f) {
    snprintf(buf, len, "-");
    return;
  }
  snprintf(buf, len, "%d%%", static_cast<int>(std::min(percent, 100.0f) + 0.5f));
}

// Time read, chapter time left and book time left above the bar; pace, percent
// and page below it.
// Missing values are left out.
void drawBookProgress(const GfxRenderer& renderer, const HeatmapBookStats& book, const int x, const int y,
                      const int width) {
  const int lineHeight = renderer.getLineHeight(SMALL_FONT_ID);
  const auto drawRightAligned = [&](const char* text, const int textY) {
    renderer.drawText(SMALL_FONT_ID, x + width - renderer.getTextWidth(SMALL_FONT_ID, text), textY, text);
  };
  char buf[32];
  if (book.readingSeconds > 0) {
    formatCompactReadingDuration(book.readingSeconds, buf, sizeof(buf));
    renderer.drawText(SMALL_FONT_ID, x, y, buf);
  }
  if (book.timeLeftSeconds > 0) {
    formatCompactReadingDuration(book.timeLeftSeconds, buf, sizeof(buf));
    drawRightAligned(buf, y);
  }
  if (book.chapterTimeLeftSeconds > 0) {
    char duration[24];
    formatCompactReadingDuration(book.chapterTimeLeftSeconds, duration, sizeof(duration));
    snprintf(buf, sizeof(buf), tr(STR_HEATMAP_CHAPTER_LEFT), duration);
    renderer.drawText(SMALL_FONT_ID, x + (width - renderer.getTextWidth(SMALL_FONT_ID, buf)) / 2, y, buf);
  }

  const int barY = y + lineHeight + kProgressLabelToBarGap;
  renderer.drawRect(x, barY, width, kProgressBarHeight, true);
  const float progress = std::clamp(book.progressPercent, 0.0f, 100.0f);
  const int filled = static_cast<int>(progress / 100.0f * static_cast<float>(width));
  if (filled > 0) renderer.fillRect(x, barY, filled, kProgressBarHeight, true);
  // Chapter starts cut the bar's inside: white over the read part, black over
  // the rest.
  for (int i = 0; i < book.chapterTickCount; ++i) {
    const int tickX = x + book.chapterTicks[i] * width / 1000;
    if (tickX <= x || tickX >= x + width - 1) continue;
    renderer.drawLine(tickX, barY + 1, tickX, barY + kProgressBarHeight - 2, tickX >= x + filled);
  }

  const int belowY = barY + kProgressBarHeight + kProgressBarToLabelGap;
  // Same pace as the book stats screens, which need over a minute of reading.
  if (book.readingSeconds > 60 && book.pagesTurned > 0) {
    const float pagesPerMinute = static_cast<float>(book.pagesTurned) * 60.0f / static_cast<float>(book.readingSeconds);
    snprintf(buf, sizeof(buf), tr(STR_HEATMAP_PAGES_PER_MIN_VALUE), pagesPerMinute);
    renderer.drawText(SMALL_FONT_ID, x, belowY, buf);
  }
  if (book.progressPercent >= 0.0f) {
    formatPercent(book.progressPercent, buf, sizeof(buf));
    renderer.drawText(SMALL_FONT_ID, x + (width - renderer.getTextWidth(SMALL_FONT_ID, buf)) / 2, belowY, buf);
  }
  if (book.page > 0 && book.pageCount > 0) {
    snprintf(buf, sizeof(buf), "%lu/%lu", static_cast<unsigned long>(book.page),
             static_cast<unsigned long>(book.pageCount));
    drawRightAligned(buf, belowY);
  }
}

// A date, its year, and an optional note (e.g. "(est.)") stacked and centered
// together on (centerX, centerY), the progress bar's middle.
void drawDateBesideBar(const GfxRenderer& renderer, const int centerX, const int centerY, const ReadingStatsDate& date,
                       const char* note) {
  if (!date.isValid()) return;
  char dayText[16];
  formatReadingStatsShortDate(date, dayText, sizeof(dayText));
  char yearText[8];
  snprintf(yearText, sizeof(yearText), "%u", static_cast<unsigned>(date.year));
  const int lineStep = renderer.getLineHeight(SMALL_FONT_ID) - kDateLineOverlap;
  const char* const lines[3] = {dayText, yearText, note};
  const int lineCount = note ? 3 : 2;
  int lineY = centerY - ((lineCount - 1) * lineStep + renderer.getLineHeight(SMALL_FONT_ID)) / 2;
  for (int i = 0; i < lineCount; ++i) {
    const char* line = lines[i];
    renderer.drawText(SMALL_FONT_ID, centerX - renderer.getTextWidth(SMALL_FONT_ID, line) / 2, lineY, line);
    lineY += lineStep;
  }
}

// "Sat, Oct 24, 2026", or "Sat, 24 Oct 2026" when the date format puts the day first.
void formatHeaderDate(const ReadingStatsDate& date, char* buf, const size_t len) {
  const char* const weekdays[kDaysPerWeek] = {tr(STR_HEATMAP_DAY_MON), tr(STR_HEATMAP_DAY_TUE), tr(STR_HEATMAP_DAY_WED),
                                              tr(STR_HEATMAP_DAY_THU), tr(STR_HEATMAP_DAY_FRI), tr(STR_HEATMAP_DAY_SAT),
                                              tr(STR_HEATMAP_DAY_SUN)};
  char month[8];
  formatReadingStatsMonthToken(date, month, sizeof(month));
  const char* weekday = weekdays[readingStatsDayOfWeekIndex(date)];
  const unsigned day = date.day;
  const unsigned year = date.year;
  switch (SETTINGS.dateFormat) {
    case CrossPointSettings::DATE_FORMAT_DAY_MONTH_YEAR_LONG:
    case CrossPointSettings::DATE_FORMAT_DAY_MONTH_YEAR_NUMERIC:
    case CrossPointSettings::DATE_FORMAT_DAY_MONTH_NUMERIC:
    case CrossPointSettings::DATE_FORMAT_DAY_MONTH_LONG:
      snprintf(buf, len, "%s, %u %s %u", weekday, day, month, year);
      break;
    default:
      snprintf(buf, len, "%s, %s %u, %u", weekday, month, day, year);
      break;
  }
}

// A filled crescent: inside a circle but outside the same circle shifted up
// and to the right.
void drawMoon(const GfxRenderer& renderer, const int x, const int y, const int size) {
  const float r = size / 2.0f;
  const float shift = size * 0.32f;
  for (int py = 0; py < size; ++py) {
    for (int px = 0; px < size; ++px) {
      const float dx = px + 0.5f - r;
      const float dy = py + 0.5f - r;
      const float cx = dx - shift;
      const float cy = dy + shift * 0.6f;
      if (dx * dx + dy * dy <= r * r && cx * cx + cy * cy > r * r * 0.72f) {
        renderer.drawPixel(x + px, y + py, true);
      }
    }
  }
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
                                   const char* coverBmpPath, const HeatmapBookStats* bookStats, const bool inverted) {
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
  const int progressHeight =
      bookStats ? 2 * smallLineHeight + kProgressLabelToBarGap + kProgressBarHeight + kProgressBarToLabelGap : 0;
  const int heatmapHeightWithoutGrid =
      (bookStats ? progressHeight + kCoverGap : 0) + monthRowHeight + kSectionGap + statsHeight;
  const auto gapForPitch = [](const int cellPitch) { return std::max(3, cellPitch / 5); };

  const int headerTop = viewTop + kTopInset;
  const int headerHeight = std::max(smallLineHeight, kMoonSize);
  const int usableTop = headerTop + headerHeight + kHeaderGap;
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

  // The date it went to sleep (a "last used" date until it wakes again) and a
  // moon marking this as the sleep screen.
  char headerDate[40];
  formatHeaderDate(today, headerDate, sizeof(headerDate));
  renderer.drawText(SMALL_FONT_ID, left + (usableWidth - renderer.getTextWidth(SMALL_FONT_ID, headerDate)) / 2,
                    headerTop + (headerHeight - smallLineHeight) / 2, headerDate);
  drawMoon(renderer, right - kMoonSize, headerTop + (headerHeight - kMoonSize) / 2, kMoonSize);

  // The cover takes whatever height the heatmap leaves; the pair is centered.
  const int coverBoxHeight = usableHeight - heatmapHeight - kCoverGap;
  int coverX = 0, coverY = 0, coverW = 0, coverH = 0;
  const bool coverDrawn =
      drawCover(renderer, coverBmpPath, left, usableTop, usableWidth, coverBoxHeight, coverX, coverY, coverW, coverH);
  int y = coverDrawn ? coverY + coverH + kCoverGap : usableTop + std::max(0, (usableHeight - heatmapHeight) / 2);
  if (bookStats) {
    // The progress bar spans the cover's width.
    drawBookProgress(renderer, *bookStats, coverDrawn ? coverX : left, y, coverDrawn ? coverW : usableWidth);
    // Start date to the left of the bar, finished or estimated finish date to
    // the right, in the space beside the cover.
    if (coverDrawn) {
      const int barCenterY = y + smallLineHeight + kProgressLabelToBarGap + kProgressBarHeight / 2;
      drawDateBesideBar(renderer, viewLeft + (coverX - viewLeft) / 2, barCenterY, bookStats->startDate, nullptr);
      drawDateBesideBar(renderer, coverX + coverW + (screenWidth - viewRight - coverX - coverW) / 2, barCenterY,
                        bookStats->endDate, bookStats->finished ? nullptr : tr(STR_HEATMAP_ESTIMATED));
    }
    y += progressHeight + kCoverGap;
  }

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

  // Stats row: Streak (best), Finished, All Time, This Month, Today.
  constexpr int kStatCount = 5;
  char values[kStatCount][24];
  formatStreak(globalStats.currentReadingStreak(&today), globalStats.displayLongestReadingStreak(&today), values[0],
               sizeof(values[0]));
  if (globalStats.completedBooks == 0) {
    snprintf(values[1], sizeof(values[1]), "-");
  } else {
    snprintf(values[1], sizeof(values[1]), "%lu", static_cast<unsigned long>(globalStats.completedBooks));
  }
  formatDuration(globalStats.totalReadingSeconds, values[2], sizeof(values[2]));
  formatDuration(monthSeconds, values[3], sizeof(values[3]));
  formatDuration(dailyMinutes ? dailyMinutes->secondsForDay(todayIndex) : 0, values[4], sizeof(values[4]));
  const char* const labels[kStatCount] = {tr(STR_HEATMAP_STREAK_BEST), tr(STR_HEATMAP_FINISHED),
                                          tr(STR_HEATMAP_ALL_TIME), tr(STR_HEATMAP_THIS_MONTH), tr(STR_HEATMAP_TODAY)};
  // Columns are as wide as their text, with equal space around each, so long
  // labels don't run into their neighbours on narrower screens.
  int columnWidths[kStatCount];
  int freeWidth = usableWidth;
  for (int i = 0; i < kStatCount; ++i) {
    columnWidths[i] = std::max(renderer.getTextWidth(UI_10_FONT_ID, values[i], EpdFontFamily::BOLD),
                               renderer.getTextWidth(SMALL_FONT_ID, labels[i]));
    freeWidth -= columnWidths[i];
  }
  const int columnSpace = std::max(0, freeWidth) / kStatCount;
  int columnX = left + columnSpace / 2;
  for (int i = 0; i < kStatCount; ++i) {
    drawStatColumn(renderer, columnX + columnWidths[i] / 2, y, values[i], labels[i]);
    columnX += columnWidths[i] + columnSpace;
  }

  if (inverted) {
    renderer.invertScreen();
  }
}
