#include "BookProgressBar.h"

#include <GfxRenderer.h>
#include <I18n.h>

#include <algorithm>
#include <cstdio>

#include "fontIds.h"

namespace {
constexpr int kLabelToBarGap = 3;
constexpr int kBarHeight = 7;
constexpr int kBarToLabelGap = 2;
// Stacks the lines of a date beside the bar closer together; small-font lines
// have spare leading.
constexpr int kDateLineOverlap = 4;

void formatPercent(const float percent, char* buf, const size_t len) {
  if (percent < 0.0f) {
    snprintf(buf, len, "-");
    return;
  }
  snprintf(buf, len, "%d%%", static_cast<int>(std::min(percent, 100.0f) + 0.5f));
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
}  // namespace

int bookProgressBarHeight(const GfxRenderer& renderer) {
  return 2 * renderer.getLineHeight(SMALL_FONT_ID) + kLabelToBarGap + kBarHeight + kBarToLabelGap;
}

int bookProgressBarMiddle(const GfxRenderer& renderer) {
  return renderer.getLineHeight(SMALL_FONT_ID) + kLabelToBarGap + kBarHeight / 2;
}

void drawBookProgressBar(const GfxRenderer& renderer, const BookProgressDetails& book, const int x, const int y,
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

  const int barY = y + lineHeight + kLabelToBarGap;
  renderer.drawRect(x, barY, width, kBarHeight, true);
  const float progress = std::clamp(book.progressPercent, 0.0f, 100.0f);
  const int filled = static_cast<int>(progress / 100.0f * static_cast<float>(width));
  if (filled > 0) renderer.fillRect(x, barY, filled, kBarHeight, true);
  // Chapter starts cut the bar's inside: white over the read part, black over
  // the rest.
  for (int i = 0; i < book.chapterTickCount; ++i) {
    const int tickX = x + book.chapterTicks[i] * width / 1000;
    if (tickX <= x || tickX >= x + width - 1) continue;
    renderer.drawLine(tickX, barY + 1, tickX, barY + kBarHeight - 2, tickX >= x + filled);
  }

  const int belowY = barY + kBarHeight + kBarToLabelGap;
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

void drawBookProgressDates(const GfxRenderer& renderer, const BookProgressDetails& book, const int leftEdge,
                           const int barX, const int barWidth, const int rightEdge, const int y) {
  const int barMiddle = y + bookProgressBarMiddle(renderer);
  drawDateBesideBar(renderer, leftEdge + (barX - leftEdge) / 2, barMiddle, book.startDate, nullptr);
  const int barRight = barX + barWidth;
  drawDateBesideBar(renderer, barRight + (rightEdge - barRight) / 2, barMiddle, book.endDate,
                    book.finished ? nullptr : tr(STR_HEATMAP_ESTIMATED));
}
