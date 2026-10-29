#include "SleepCoverAssets.h"

#include <Epub.h>
#include <FsHelpers.h>
#include <HalStorage.h>
#include <Txt.h>
#include <Xtc.h>

#include <cstdint>

#include "CrossPointSettings.h"
#include "components/UITheme.h"
#include "components/themes/dashboard/DashboardTheme.h"
#include "components/themes/minimal/MinimalTheme.h"

namespace {

constexpr int kMinimalSleepCoverHeight = MinimalMetrics::homeCoverImageHeight;
constexpr int kMinimalSleepCoverWidth = MinimalMetrics::homeCoverImageWidth;
constexpr int kDashboardSleepCoverHeight = DashboardMetrics::homeCoverImageHeight;
constexpr int kDashboardSleepCoverWidth = DashboardMetrics::homeCoverImageWidth;
// The largest 2:3 cover that leaves room for the Reading Heatmap's progress bar,
// grid and stats on the X3, drawn at native size so dithered covers stay clean.
constexpr int kHeatmapSleepCoverWidth = 298;
constexpr int kHeatmapSleepCoverHeight = 447;

bool shouldPrepareFullCover() {
  return SETTINGS.sleepScreen == CrossPointSettings::SLEEP_SCREEN_MODE::COVER ||
         SETTINGS.sleepScreen == CrossPointSettings::SLEEP_SCREEN_MODE::COVER_CUSTOM;
}

bool shouldPrepareMinimalCover() {
  return SETTINGS.sleepScreen == CrossPointSettings::SLEEP_SCREEN_MODE::MINIMAL_SLEEP ||
         SETTINGS.sleepScreen == CrossPointSettings::SLEEP_SCREEN_MODE::MINIMAL_STATS_SLEEP;
}

bool shouldPrepareHeatmapCover() {
  return SETTINGS.sleepScreen == CrossPointSettings::SLEEP_SCREEN_MODE::HEATMAP_SLEEP;
}

bool shouldPrepareDashboardCover() {
  return SETTINGS.sleepScreen == CrossPointSettings::SLEEP_SCREEN_MODE::DASHBOARD_SLEEP;
}

bool fileExists(const std::string& path) { return !path.empty() && Storage.exists(path.c_str()); }

int readerFontIdForRenderer(const GfxRenderer* renderer) { return renderer ? SETTINGS.getReaderFontId() : 0; }

bool prepareThumbCoverForPath(const std::string& bookPath, const GfxRenderer* renderer, const int width,
                              const int height) {
  if (bookPath.empty()) {
    return false;
  }

  if (FsHelpers::hasEpubExtension(bookPath)) {
    Epub epub(bookPath, "/.crosspoint");
    if (!epub.load(/*buildIfMissing=*/true, /*skipLoadingCss=*/true, Epub::XLocationLoadMode::Skip)) {
      return false;
    }
    return epub.generateAdaptiveThumbBmp(width, height, renderer, readerFontIdForRenderer(renderer));
  }
  if (FsHelpers::hasXtcExtension(bookPath)) {
    Xtc xtc(bookPath, "/.crosspoint");
    if (!xtc.load()) {
      return false;
    }
    return xtc.generateThumbBmp(static_cast<uint16_t>(width), static_cast<uint16_t>(height));
  }
  if (FsHelpers::hasTxtExtension(bookPath) || FsHelpers::hasMarkdownExtension(bookPath)) {
    Txt txt(bookPath, "/.crosspoint");
    return txt.generateCoverBmp();
  }
  return false;
}

}  // namespace

namespace SleepCoverAssets {

bool prepareXtc(const Xtc& xtc) {
  bool success = true;
  if (shouldPrepareFullCover()) {
    success = xtc.generateCoverBmp() && success;
  }
  if (shouldPrepareMinimalCover()) {
    success = xtc.generateThumbBmp(static_cast<uint16_t>(kMinimalSleepCoverWidth),
                                   static_cast<uint16_t>(kMinimalSleepCoverHeight)) &&
              success;
  }
  if (shouldPrepareDashboardCover()) {
    success = xtc.generateThumbBmp(static_cast<uint16_t>(kDashboardSleepCoverWidth),
                                   static_cast<uint16_t>(kDashboardSleepCoverHeight)) &&
              success;
  }
  if (shouldPrepareHeatmapCover()) {
    success = xtc.generateThumbBmp(static_cast<uint16_t>(kHeatmapSleepCoverWidth),
                                   static_cast<uint16_t>(kHeatmapSleepCoverHeight)) &&
              success;
  }
  return success;
}

bool prepareTxt(const Txt& txt) {
  if (!shouldPrepareFullCover() && !shouldPrepareMinimalCover() && !shouldPrepareDashboardCover() &&
      !shouldPrepareHeatmapCover()) {
    return true;
  }
  return txt.generateCoverBmp();
}

bool prepareFullCoverForPath(const std::string& bookPath, const bool cropped, const GfxRenderer* renderer,
                             bool imageLevels) {
  if (bookPath.empty()) {
    return false;
  }

  if (FsHelpers::hasEpubExtension(bookPath)) {
    Epub epub(bookPath, "/.crosspoint");
    if (!epub.load(/*buildIfMissing=*/false, /*skipLoadingCss=*/true, Epub::XLocationLoadMode::Skip)) {
      return false;
    }
    return epub.generateCoverBmp(cropped, renderer, readerFontIdForRenderer(renderer), imageLevels);
  }
  if (FsHelpers::hasXtcExtension(bookPath)) {
    Xtc xtc(bookPath, "/.crosspoint");
    if (!xtc.load()) {
      return false;
    }
    return xtc.generateCoverBmp();
  }
  if (FsHelpers::hasTxtExtension(bookPath) || FsHelpers::hasMarkdownExtension(bookPath)) {
    Txt txt(bookPath, "/.crosspoint");
    return txt.generateCoverBmp(imageLevels);
  }
  return false;
}

bool prepareMinimalCoverForPath(const std::string& bookPath, const GfxRenderer* renderer) {
  return prepareThumbCoverForPath(bookPath, renderer, kMinimalSleepCoverWidth, kMinimalSleepCoverHeight);
}

bool prepareDashboardCoverForPath(const std::string& bookPath, const GfxRenderer* renderer) {
  return prepareThumbCoverForPath(bookPath, renderer, kDashboardSleepCoverWidth, kDashboardSleepCoverHeight);
}

bool prepareHeatmapCoverForPath(const std::string& bookPath, const GfxRenderer* renderer) {
  return prepareThumbCoverForPath(bookPath, renderer, kHeatmapSleepCoverWidth, kHeatmapSleepCoverHeight);
}

std::string reusableCoverPathFor(const std::string& bookPath) {
  if (FsHelpers::hasEpubExtension(bookPath)) {
    return Epub(bookPath, "/.crosspoint").getThumbBmpPath();
  }
  if (FsHelpers::hasXtcExtension(bookPath)) {
    return Xtc(bookPath, "/.crosspoint").getThumbBmpPath();
  }
  if (FsHelpers::hasTxtExtension(bookPath) || FsHelpers::hasMarkdownExtension(bookPath)) {
    return Txt(bookPath, "/.crosspoint").getCoverBmpPath();
  }
  return {};
}

std::string cachedCoverPathFor(const std::string& bookPath, const bool cropped, bool imageLevels) {
  std::string coverPath;
  if (FsHelpers::hasEpubExtension(bookPath)) {
    coverPath = Epub(bookPath, "/.crosspoint").getCoverBmpPath(cropped, imageLevels);
  } else if (FsHelpers::hasXtcExtension(bookPath)) {
    coverPath = Xtc(bookPath, "/.crosspoint").getCoverBmpPath();
  } else if (FsHelpers::hasTxtExtension(bookPath) || FsHelpers::hasMarkdownExtension(bookPath)) {
    coverPath = Txt(bookPath, "/.crosspoint").getCoverBmpPath(imageLevels);
  }

  return fileExists(coverPath) ? coverPath : std::string{};
}

std::string cachedMinimalCoverPathFor(const std::string& bookPath) {
  if (FsHelpers::hasEpubExtension(bookPath)) {
    const Epub epub(bookPath, "/.crosspoint");
    const std::string coverPath = epub.getAdaptiveThumbBmpPath(kMinimalSleepCoverWidth, kMinimalSleepCoverHeight);
    return fileExists(coverPath) ? epub.getThumbBmpPath() : std::string{};
  }

  const std::string reusablePath = reusableCoverPathFor(bookPath);
  const std::string coverPath =
      UITheme::getCoverThumbPath(reusablePath, kMinimalSleepCoverWidth, kMinimalSleepCoverHeight);
  return fileExists(coverPath) ? reusablePath : std::string{};
}

std::string cachedDashboardCoverPathFor(const std::string& bookPath) {
  if (FsHelpers::hasEpubExtension(bookPath)) {
    const Epub epub(bookPath, "/.crosspoint");
    const std::string coverPath = epub.getAdaptiveThumbBmpPath(kDashboardSleepCoverWidth, kDashboardSleepCoverHeight);
    return fileExists(coverPath) ? epub.getThumbBmpPath() : std::string{};
  }

  const std::string reusablePath = reusableCoverPathFor(bookPath);
  const std::string coverPath =
      UITheme::getCoverThumbPath(reusablePath, kDashboardSleepCoverWidth, kDashboardSleepCoverHeight);
  return fileExists(coverPath) ? reusablePath : std::string{};
}

std::string heatmapCoverBmpPathFor(const std::string& bookPath) {
  const std::string coverPath =
      FsHelpers::hasEpubExtension(bookPath)
          ? Epub(bookPath, "/.crosspoint").getAdaptiveThumbBmpPath(kHeatmapSleepCoverWidth, kHeatmapSleepCoverHeight)
          : UITheme::getCoverThumbPath(reusableCoverPathFor(bookPath), kHeatmapSleepCoverWidth,
                                       kHeatmapSleepCoverHeight);
  return fileExists(coverPath) ? coverPath : std::string{};
}

}  // namespace SleepCoverAssets
