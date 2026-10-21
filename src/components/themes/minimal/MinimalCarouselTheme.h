#pragma once

#include "components/themes/lyra/LyraCarouselTheme.h"
#include "components/themes/minimal/MinimalTheme.h"

// Minimal Carousel: Minimal's screens and front-button home navigation, with
// Lyra Carousel's three-book cover strip on Home.
namespace MinimalCarouselMetrics {
// Without Lyra Carousel's icon row there is room below the strip, so the title,
// covers and progress footer sit a little lower.
constexpr int kHomeContentDrop = 16;

constexpr ThemeMetrics makeValues() {
  ThemeMetrics v = MinimalMetrics::values;
  // Same cover sizes as Lyra Carousel, so both themes share the cover thumbnails.
  v.homeTopPadding = LyraCarouselMetrics::values.homeTopPadding + kHomeContentDrop;
  v.homeCoverHeight = LyraCarouselMetrics::values.homeCoverHeight;
  v.homeCoverTileHeight = LyraCarouselMetrics::values.homeCoverTileHeight;
  v.homeRecentBooksCount = LyraCarouselMetrics::values.homeRecentBooksCount;
  return v;
}

constexpr ThemeMetrics values = makeValues();
}  // namespace MinimalCarouselMetrics

class MinimalCarouselTheme : public MinimalTheme {
 public:
  // Home draws the carousel's live progress footer over cached artwork.
  const LyraCarouselTheme& carousel() const { return carousel_; }

  void drawRecentBookCover(GfxRenderer& renderer, Rect rect, const std::vector<RecentBook>& recentBooks,
                           int selectorIndex, bool& coverRendered, bool& coverBufferStored, bool& bufferRestored,
                           const std::function<bool()>& storeCoverBuffer, const BookReadingStats* stats = nullptr,
                           float progressPercent = -1.0f, const GlobalReadingStats* globalStats = nullptr,
                           const char* currentChapterTitle = nullptr) const override {
    carousel_.drawRecentBookCover(renderer, rect, recentBooks, selectorIndex, coverRendered, coverBufferStored,
                                  bufferRestored, storeCoverBuffer, stats, progressPercent, globalStats,
                                  currentChapterTitle);
  }
  void drawCarouselBorder(GfxRenderer& renderer, Rect coverRect, const std::vector<RecentBook>& recentBooks,
                          int centerIdx, bool inCarouselRow) const override {
    carousel_.drawCarouselBorder(renderer, coverRect, recentBooks, centerIdx, inCarouselRow);
  }

 private:
  // Stateless apart from its vtable; the carousel's drawing state lives in
  // LyraCarouselTheme.cpp statics shared with the Lyra Carousel theme.
  LyraCarouselTheme carousel_;
};
