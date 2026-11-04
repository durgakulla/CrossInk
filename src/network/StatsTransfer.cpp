#include "StatsTransfer.h"

#include <AppVersion.h>
#include <ArduinoJson.h>
#include <Epub.h>
#include <FsHelpers.h>
#include <HalStorage.h>
#include <Logging.h>
#include <Memory.h>
#include <Print.h>
#include <Xtc.h>

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <deque>
#include <string>
#include <vector>

#include "RecentBooksStore.h"
#include "activities/home/RecentBookProgress.h"
#include "activities/reader/BookReadingStats.h"
#include "activities/reader/BookStatsTracking.h"
#include "activities/reader/DailyReadingMinutes.h"
#include "activities/reader/GlobalReadingStats.h"
#include "activities/reader/StablePace.h"
#include "activities/reader/ReadingStatsUtils.h"
#include "activities/reader/SavedBookInfo.h"

#ifndef CROSSINK_FIRMWARE_DEVICE_TYPE
#define CROSSINK_FIRMWARE_DEVICE_TYPE "unknown"
#endif

namespace StatsTransfer {
namespace {

constexpr char kFormat[] = "crossink-stats";
constexpr int kVersion = 1;
// Longest record: the daily log's 189 day counts, well under this.
constexpr size_t kMaxLineLength = 4096;

// Where a book's stats live; EPUB and XTC books have stats (as in
// SleepActivity's bookStatsCachePathFor).
std::string statsCachePathFor(const std::string& path) {
  if (FsHelpers::hasEpubExtension(path)) return Epub::resolveCachePathForFilePath(path, "/.crosspoint");
  if (FsHelpers::hasXtcExtension(path)) return Xtc(path, "/.crosspoint").getCachePath();
  return {};
}

void writeRecord(const JsonDocument& doc, Print& out) {
  out.print("STATS:");
  serializeJson(doc, out);
  out.print("\n");
}

// "YYYY-MM-DD", or null when the date is unknown. Field is a document member
// (doc["key"]); taking it by its own type lets setting it create the member.
template <typename Field>
void setDate(Field field, const ReadingStatsDate& date) {
  if (!date.isValid()) {
    field.set(nullptr);
    return;
  }
  char text[11];
  snprintf(text, sizeof(text), "%04u-%02u-%02u", static_cast<unsigned>(date.year), static_cast<unsigned>(date.month),
           static_cast<unsigned>(date.day));
  field.set(text);
}

bool parseDate(JsonVariantConst field, ReadingStatsDate& out) {
  out.clear();
  if (field.isNull()) return true;
  const char* text = field.as<const char*>();
  unsigned year = 0, month = 0, day = 0;
  if (!text || sscanf(text, "%4u-%2u-%2u", &year, &month, &day) != 3) return false;
  out = {static_cast<uint16_t>(year), static_cast<uint8_t>(month), static_cast<uint8_t>(day)};
  return out.isValid();
}

template <typename Field, size_t N>
void setArray(Field field, const std::array<uint32_t, N>& values) {
  JsonArray array = field.template to<JsonArray>();
  for (const uint32_t v : values) array.add(v);
}

template <size_t N>
bool parseArray(JsonVariantConst field, std::array<uint32_t, N>& out) {
  JsonArrayConst array = field.as<JsonArrayConst>();
  if (array.isNull() || array.size() != N) return false;
  size_t i = 0;
  for (JsonVariantConst v : array) {
    if (!v.is<uint32_t>()) return false;
    out[i++] = v.as<uint32_t>();
  }
  return true;
}

bool parseHex(const char* text, std::array<uint8_t, READING_HISTORY_BYTES>& out) {
  if (!text || strlen(text) != out.size() * 2) return false;
  for (size_t i = 0; i < out.size(); ++i) {
    unsigned byte = 0;
    if (sscanf(text + i * 2, "%2x", &byte) != 1) return false;
    out[i] = static_cast<uint8_t>(byte);
  }
  return true;
}

// Each apply function validates a record; it saves only when commit is set.
bool applyGlobal(JsonObjectConst record, const bool commit) {
  GlobalReadingStats stats;
  stats.totalSessions = record["sessions"] | 0u;
  stats.totalReadingSeconds = record["seconds"] | 0u;
  stats.totalPagesTurned = record["pages"] | 0u;
  stats.completedBooks = record["completedBooks"] | 0u;
  stats.readingHistoryAnchorDay = record["historyAnchor"] | 0u;
  stats.longestReadingStreak = record["longestStreakRecord"] | 0u;
  if (!parseArray(record["timeOfDay"], stats.timeOfDaySeconds) ||
      !parseArray(record["dayOfWeek"], stats.dayOfWeekSeconds) ||
      !parseHex(record["history"] | "", stats.readingHistoryBits)) {
    return false;
  }
  if (commit) stats.save();
  return true;
}

bool applyDaily(JsonObjectConst record, const bool commit) {
  DailyReadingMinutes daily;
  daily.anchorDay = record["anchorDay"] | 0u;
  if (!parseArray(record["seconds"], daily.seconds)) return false;
  return !commit || daily.save();
}

// Returns false for an invalid record. Books not on this card keep their
// stats too, listed as deleted books.
bool applyBook(JsonObjectConst record, const bool commit) {
  const std::string path = record["path"] | "";
  const std::string cachePath = path.empty() || path.front() != '/' ? std::string{} : statsCachePathFor(path);
  if (cachePath.empty()) return false;

  BookReadingStats stats;
  stats.sessionCount = record["sessions"] | 0u;
  stats.totalReadingSeconds = record["seconds"] | 0u;
  stats.totalPagesTurned = record["pages"] | 0u;
  stats.isCompleted = record["completed"] | false;
  stats.avgSecondsPerForwardPage = record["avgSecondsPerPage"] | 0u;
  stats.paceSampleCount = record["paceSamples"] | 0u;
  stats.estimatedTimeLeftSeconds = record["timeLeftSeconds"] | 0u;
  stats.startDateManual = record["startDateManual"] | false;
  stats.finishedDateManual = record["finishedDateManual"] | false;
  if (!parseDate(record["startDate"], stats.startDate) || !parseDate(record["finishedDate"], stats.finishedDate) ||
      !parseArray(record["timeOfDay"], stats.timeOfDaySeconds) ||
      !parseArray(record["dayOfWeek"], stats.dayOfWeekSeconds)) {
    return false;
  }
  // Stable-page pace (firmware 1.7.0+ backups); older backups have none.
  StablePace pace;
  const bool hasPace = !record["stablePages"].isNull() || !record["stableSeconds"].isNull();
  if (hasPace) {
    if (!record["stablePages"].is<uint32_t>() || !record["stableSeconds"].is<uint32_t>()) return false;
    pace.pages = record["stablePages"].as<uint32_t>();
    pace.seconds = record["stableSeconds"].as<uint32_t>();
  }
  if (!commit) return true;
  Storage.mkdir(cachePath.c_str(), true);
  SavedBookInfo::save(cachePath, path, record["title"] | "", record["author"] | "");
  return stats.save(cachePath) && (!hasPace || pace.save(cachePath));
}

// Reads one line into buffer; false at the end of the file or when a line is
// longer than the buffer.
bool readLine(HalFile& file, char* buffer, size_t capacity, bool& tooLong) {
  size_t length = 0;
  tooLong = false;
  int c;
  while ((c = file.read()) >= 0) {
    if (c == '\n') break;
    if (c == '\r') continue;
    if (length + 1 >= capacity) {
      tooLong = true;
      return false;
    }
    buffer[length++] = static_cast<char>(c);
  }
  buffer[length] = '\0';
  return c >= 0 || length > 0;
}

}  // namespace

void writeGlobalStats(Print& out) {
  ReadingStatsDateTime now;
  const bool hasToday = getCurrentLocalReadingStatsDateTime(now);

  JsonDocument meta;
  meta["type"] = "meta";
  meta["format"] = kFormat;
  meta["version"] = kVersion;
  meta["firmware"] = AppVersion::version();
  meta["device"] = CROSSINK_FIRMWARE_DEVICE_TYPE;
  setDate(meta["today"], hasToday ? now.date : ReadingStatsDate{});
  if (hasToday) meta["todayIndex"] = readingStatsDayIndex(now.date);
  writeRecord(meta, out);

  const GlobalReadingStats stats = GlobalReadingStats::load();
  JsonDocument global;
  global["type"] = "global";
  global["sessions"] = stats.totalSessions;
  global["seconds"] = stats.totalReadingSeconds;
  global["pages"] = stats.totalPagesTurned;
  global["completedBooks"] = stats.completedBooks;
  setArray(global["timeOfDay"], stats.timeOfDaySeconds);
  setArray(global["dayOfWeek"], stats.dayOfWeekSeconds);
  global["historyAnchor"] = stats.readingHistoryAnchorDay;
  char hex[READING_HISTORY_BYTES * 2 + 1];
  for (size_t i = 0; i < stats.readingHistoryBits.size(); ++i) {
    snprintf(hex + i * 2, 3, "%02x", stats.readingHistoryBits[i]);
  }
  global["history"] = hex;
  global["longestStreakRecord"] = stats.longestReadingStreak;
  global["currentStreak"] = stats.currentReadingStreak(hasToday ? &now.date : nullptr);
  global["longestStreak"] = stats.displayLongestReadingStreak(hasToday ? &now.date : nullptr);
  writeRecord(global, out);

  // The per-day log is ~760 bytes, too large for this task's stack.
  auto daily = makeUniqueNoThrow<DailyReadingMinutes>();
  if (!daily) {
    LOG_ERR("STATSX", "OOM loading daily reading log for export");
    return;
  }
  DailyReadingMinutes::load(*daily);
  JsonDocument record;
  record["type"] = "daily";
  record["anchorDay"] = daily->anchorDay;
  setArray(record["seconds"], daily->seconds);
  writeRecord(record, out);
}

std::string coverThumbPath(const char* path, uint32_t* size) {
  const std::string cachePath = statsCachePathFor(path ? path : "");
  if (cachePath.empty()) return {};
  HalFile dir = Storage.open(cachePath.c_str());
  if (!dir || !dir.isDirectory()) {
    if (dir) dir.close();
    return {};
  }
  std::string best;
  uint32_t bestSize = 0;
  char name[64];
  HalFile file = dir.openNextFile();
  while (file) {
    file.getName(name, sizeof(name));
    const size_t length = strlen(name);
    // thumb_<w>x<h>.bmp; the "_fit" variants are letterboxed for Home themes.
    const bool isThumb = strncmp(name, "thumb_", 6) == 0 && length > 10 && strcmp(name + length - 4, ".bmp") == 0 &&
                         strstr(name, "_fit") == nullptr;
    if (isThumb && file.size() > bestSize) {
      bestSize = static_cast<uint32_t>(file.size());
      best = cachePath + "/" + name;
    }
    file.close();
    file = dir.openNextFile();
  }
  dir.close();
  if (size) *size = bestSize;
  return best;
}

bool writeLibraryEntry(const char* path, Print& out) {
  const std::string bookPath = path ? path : "";
  const bool txt = FsHelpers::hasTxtExtension(bookPath) || FsHelpers::hasMarkdownExtension(bookPath);
  const std::string cachePath = statsCachePathFor(bookPath);
  if (cachePath.empty() && !txt) return false;

  const RecentBook book = RECENT_BOOKS.getDataFromBook(bookPath);
  JsonDocument record;
  record["path"] = bookPath;
  record["title"] = book.title;
  record["author"] = book.author;
  const float progress = RecentBookProgress::loadPercent(book);
  if (RecentBookProgress::hasPercent(progress)) {
    record["progress"] = progress;
  } else {
    record["progress"] = nullptr;
  }
  if (!cachePath.empty() && Storage.exists(cachePath.c_str())) {
    const BookReadingStats stats = BookReadingStats::load(cachePath);
    record["seconds"] = stats.totalReadingSeconds;
    record["sessions"] = stats.sessionCount;
    record["completed"] = stats.isCompleted;
  }
  uint32_t coverSize = 0;
  coverThumbPath(path, &coverSize);
  record["cover"] = coverSize;
  out.print("BOOK:");
  serializeJson(record, out);
  out.print("\n");
  return true;
}

namespace {

// Stats worth listing: tracking is on and some reading was recorded.
bool hasBookStats(const std::string& cachePath, BookReadingStats& stats) {
  if (cachePath.empty() || !Storage.exists(cachePath.c_str()) || !BookStatsTracking::isEnabled(cachePath)) {
    return false;
  }
  stats = BookReadingStats::load(cachePath);
  return stats.sessionCount > 0 || stats.totalReadingSeconds > 0 || stats.isCompleted;
}

// The fields after path, title, author and progress, shared by books on the
// card and deleted ones.
void writeBookStatsRecord(JsonDocument& record, const std::string& cachePath, const BookReadingStats& stats,
                          Print& out) {
  record["sessions"] = stats.sessionCount;
  record["seconds"] = stats.totalReadingSeconds;
  record["pages"] = stats.totalPagesTurned;
  record["completed"] = stats.isCompleted;
  record["avgSecondsPerPage"] = stats.avgSecondsPerForwardPage;
  record["paceSamples"] = stats.paceSampleCount;
  record["timeLeftSeconds"] = stats.estimatedTimeLeftSeconds;
  record["startDateManual"] = stats.startDateManual;
  record["finishedDateManual"] = stats.finishedDateManual;
  setDate(record["startDate"], stats.startDate);
  setDate(record["finishedDate"], stats.finishedDate);
  setArray(record["timeOfDay"], stats.timeOfDaySeconds);
  setArray(record["dayOfWeek"], stats.dayOfWeekSeconds);
  const StablePace pace = StablePace::load(cachePath);
  if (pace.tracked) {
    record["stablePages"] = pace.pages;
    record["stableSeconds"] = pace.seconds;
  }
  writeRecord(record, out);
}

// Stats kept for books no longer on the card: cache folders whose saved book
// info names a missing file. A folder that no longer matches its saved path
// was moved with a renamed book, which is still on the card.
void writeDeletedBookStats(Print& out) {
  HalFile root = Storage.open("/.crosspoint");
  if (!root || !root.isDirectory()) {
    if (root) root.close();
    return;
  }
  std::vector<std::string> folders;
  char name[64];
  HalFile file = root.openNextFile();
  while (file) {
    file.getName(name, sizeof(name));
    if (file.isDirectory() && (strncmp(name, "epub_", 5) == 0 || strncmp(name, "xtc_", 4) == 0)) {
      folders.push_back(std::string("/.crosspoint/") + name);
    }
    file.close();
    yield();
    file = root.openNextFile();
  }
  root.close();

  SavedBookInfo info;
  BookReadingStats stats;
  for (const std::string& cachePath : folders) {
    if (!SavedBookInfo::load(cachePath, info) || statsCachePathFor(info.path) != cachePath ||
        Storage.exists(info.path.c_str()) || !hasBookStats(cachePath, stats)) {
      continue;
    }
    JsonDocument record;
    record["type"] = "book";
    record["path"] = info.path;
    record["title"] = info.title;
    record["author"] = info.author;
    record["progress"] = nullptr;
    record["deleted"] = true;
    writeBookStatsRecord(record, cachePath, stats, out);
    yield();
  }
}

}  // namespace

bool writeBookStats(const char* path, Print& out) {
  const std::string bookPath = path ? path : "";
  const std::string cachePath = statsCachePathFor(bookPath);
  BookReadingStats stats;
  if (!hasBookStats(cachePath, stats)) return false;

  const auto& recents = RECENT_BOOKS.getBooks();
  const auto recent = std::find_if(recents.begin(), recents.end(),
                                   [&bookPath](const RecentBook& book) { return book.path == bookPath; });
  const RecentBook book = recent != recents.end() ? *recent : RECENT_BOOKS.getDataFromBook(bookPath);
  // Books read before book info was saved get it here, so their stats still
  // list after they're deleted.
  if (!book.title.empty()) SavedBookInfo::save(cachePath, bookPath, book.title, book.author);

  JsonDocument record;
  record["type"] = "book";
  record["path"] = bookPath;
  record["title"] = book.title;
  record["author"] = book.author;
  const float progress = RecentBookProgress::loadPercent(book);
  if (RecentBookProgress::hasPercent(progress)) {
    record["progress"] = progress;
  } else {
    record["progress"] = nullptr;
  }
  writeBookStatsRecord(record, cachePath, stats, out);
  return true;
}

namespace {

// One pass over the import file: validates every record, and saves them when
// commit is set.
ImportResult runImport(const char* path, char* line, const bool commit) {
  ImportResult result;
  HalFile file;
  if (!Storage.openFileForRead("STATSX", path, file)) {
    result.error = "open";
    return result;
  }
  bool sawMeta = false;
  bool tooLong = false;
  while (readLine(file, line, kMaxLineLength, tooLong)) {
    if (line[0] == '\0') continue;
    JsonDocument doc;
    if (deserializeJson(doc, line)) {
      file.close();
      result.error = "json";
      return result;
    }
    JsonObjectConst record = doc.as<JsonObjectConst>();
    const char* type = record["type"] | "";
    if (!sawMeta) {
      if (strcmp(type, "meta") != 0 || strcmp(record["format"] | "", kFormat) != 0 ||
          (record["version"] | 0) != kVersion) {
        file.close();
        result.error = "format";
        return result;
      }
      sawMeta = true;
      continue;
    }
    bool valid = true;
    if (strcmp(type, "global") == 0) {
      valid = applyGlobal(record, commit);
      result.global = result.global || valid;
    } else if (strcmp(type, "daily") == 0) {
      valid = applyDaily(record, commit);
      result.daily = result.daily || valid;
    } else if (strcmp(type, "book") == 0) {
      valid = applyBook(record, commit);
      if (valid) result.books++;
    }
    if (!valid) {
      file.close();
      LOG_ERR("STATSX", "Invalid %s record in the stats import", type);
      result.error = commit ? "save" : "record";
      return result;
    }
    yield();
  }
  file.close();
  if (tooLong) {
    result.error = "line_too_long";
    return result;
  }
  if (!sawMeta) {
    result.error = "format";
    return result;
  }
  result.ok = true;
  return result;
}

}  // namespace

void writeAllBookStats(Print& out, bool (*skipName)(const char* name)) {
  constexpr size_t kMaxDepth = 6;
  constexpr size_t kMaxFolders = 300;
  struct Folder {
    std::string path;
    size_t depth;
  };
  std::deque<Folder> pending{{"", 0}};
  size_t visited = 0;
  std::vector<std::string> books;
  while (!pending.empty() && visited < kMaxFolders) {
    const Folder folder = pending.front();
    pending.pop_front();
    visited++;
    // Read the whole folder before describing its books, which opens their
    // cache files.
    books.clear();
    HalFile root = Storage.open(folder.path.empty() ? "/" : folder.path.c_str());
    if (root && root.isDirectory()) {
      char name[256];
      HalFile file = root.openNextFile();
      while (file) {
        file.getName(name, sizeof(name));
        if (name[0] != '.' && !(skipName && skipName(name))) {
          std::string path = folder.path + "/" + name;
          if (file.isDirectory()) {
            if (folder.depth + 1 <= kMaxDepth) pending.push_back({std::move(path), folder.depth + 1});
          } else if (FsHelpers::hasEpubExtension(path) || FsHelpers::hasXtcExtension(path)) {
            books.push_back(std::move(path));
          }
        }
        file.close();
        yield();
        file = root.openNextFile();
      }
    }
    if (root) root.close();
    char scan[24];
    snprintf(scan, sizeof(scan), "SCAN:%u\n", static_cast<unsigned>(visited));
    out.print(scan);
    for (const std::string& path : books) {
      out.print("PATH:");
      out.print(path.c_str());
      out.print("\n");
      writeBookStats(path.c_str(), out);
      yield();
    }
  }
  writeDeletedBookStats(out);
}

ImportResult importStatsFile(const char* path) {
  ImportResult result;
  // A line holds one record; reading line by line keeps memory flat for any
  // number of books.
  auto line = makeUniqueNoThrow<char[]>(kMaxLineLength);
  if (!line) {
    LOG_ERR("STATSX", "OOM importing stats");
    result.error = "oom";
  } else {
    // Check the whole file first so a bad backup changes nothing.
    result = runImport(path, line.get(), false);
    if (result.ok) result = runImport(path, line.get(), true);
  }
  Storage.remove(path);
  return result;
}

}  // namespace StatsTransfer
