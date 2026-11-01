#include "StablePace.h"

#include <HalStorage.h>
#include <Logging.h>

#include "BookReadingStats.h"

namespace {

constexpr const char* kFileName = "/stable_pace.bin";
constexpr uint8_t kVersion = 1;
constexpr size_t kFileSize = 9;  // [0] version, [1-4] pages, [5-8] seconds (uint32_t LE)
// Stable pace shows once this much reading has been measured.
constexpr uint32_t kMinStableSeconds = 120;
// Turn pace keeps the book stats screens' existing threshold.
constexpr uint32_t kMinTurnSeconds = 60;

uint32_t readLe32(const uint8_t* data) {
  return static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
         (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
}

void writeLe32(uint8_t* data, const uint32_t value) {
  data[0] = value & 0xFF;
  data[1] = (value >> 8) & 0xFF;
  data[2] = (value >> 16) & 0xFF;
  data[3] = (value >> 24) & 0xFF;
}

}  // namespace

StablePace StablePace::load(const std::string& cachePath) {
  StablePace pace;
  HalFile file;
  if (!Storage.openFileForRead("PACE", cachePath + kFileName, file)) return pace;
  uint8_t data[kFileSize] = {};
  const int read = file.read(data, kFileSize);
  file.close();
  if (read != static_cast<int>(kFileSize) || data[0] != kVersion) {
    LOG_ERR("PACE", "Ignoring invalid stable pace file in %s", cachePath.c_str());
    return pace;
  }
  pace.pages = readLe32(data + 1);
  pace.seconds = readLe32(data + 5);
  pace.tracked = true;
  return pace;
}

bool StablePace::save(const std::string& cachePath) {
  uint8_t data[kFileSize];
  data[0] = kVersion;
  writeLe32(data + 1, pages);
  writeLe32(data + 5, seconds);
  const std::string path = cachePath + kFileName;
  const std::string tmpPath = path + ".tmp";
  HalFile file;
  if (!Storage.openFileForWrite("PACE", tmpPath, file)) {
    LOG_ERR("PACE", "Could not write %s", tmpPath.c_str());
    return false;
  }
  const size_t written = file.write(data, kFileSize);
  file.close();
  if (written != kFileSize) {
    LOG_ERR("PACE", "Short write to %s", tmpPath.c_str());
    Storage.remove(tmpPath.c_str());
    return false;
  }
  Storage.remove(path.c_str());
  if (!Storage.rename(tmpPath.c_str(), path.c_str())) {
    LOG_ERR("PACE", "Could not publish %s", path.c_str());
    return false;
  }
  tracked = true;
  return true;
}

bool StablePace::remove(const std::string& cachePath) {
  const std::string path = cachePath + kFileName;
  Storage.remove((path + ".tmp").c_str());
  return !Storage.exists(path.c_str()) || Storage.remove(path.c_str());
}

void StablePace::add(const uint32_t stablePages, const uint32_t turnSeconds) {
  if (pages > UINT32_MAX - stablePages || seconds > UINT32_MAX - turnSeconds) return;
  pages += stablePages;
  seconds += turnSeconds;
}

bool readingPagesPerMinute(const BookReadingStats& stats, const StablePace& pace, float& out) {
  if (pace.tracked) {
    if (pace.seconds < kMinStableSeconds) return false;
    out = static_cast<float>(pace.pages) * 60.0f / static_cast<float>(pace.seconds);
    return true;
  }
  if (stats.totalReadingSeconds <= kMinTurnSeconds || stats.totalPagesTurned == 0) return false;
  out = static_cast<float>(stats.totalPagesTurned) * 60.0f / static_cast<float>(stats.totalReadingSeconds);
  return true;
}
