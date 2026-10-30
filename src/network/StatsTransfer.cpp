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
#include <string>

#include "RecentBooksStore.h"
#include "activities/home/RecentBookProgress.h"
#include "activities/reader/BookReadingStats.h"
#include "activities/reader/BookStatsTracking.h"
#include "activities/reader/DailyReadingMinutes.h"
#include "activities/reader/GlobalReadingStats.h"
#include "activities/reader/ReadingStatsUtils.h"

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

// Returns false for an invalid record; skipped is set when the book's file
// isn't on this card.
bool applyBook(JsonObjectConst record, const bool commit, bool& skipped) {
  skipped = false;
  const std::string path = record["path"] | "";
  const std::string cachePath = path.empty() || path.front() != '/' ? std::string{} : statsCachePathFor(path);
  if (cachePath.empty()) return false;
  if (!Storage.exists(path.c_str())) {
    skipped = true;
    return true;
  }

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
  if (!commit) return true;
  Storage.mkdir(cachePath.c_str(), true);
  return stats.save(cachePath);
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

bool writeBookStats(const char* path, Print& out) {
  const std::string bookPath = path ? path : "";
  const std::string cachePath = statsCachePathFor(bookPath);
  if (cachePath.empty() || !Storage.exists(cachePath.c_str()) || !BookStatsTracking::isEnabled(cachePath)) {
    return false;
  }
  const BookReadingStats stats = BookReadingStats::load(cachePath);
  if (stats.sessionCount == 0 && stats.totalReadingSeconds == 0 && !stats.isCompleted) return false;

  const auto& recents = RECENT_BOOKS.getBooks();
  const auto recent = std::find_if(recents.begin(), recents.end(),
                                   [&bookPath](const RecentBook& book) { return book.path == bookPath; });
  const RecentBook book = recent != recents.end() ? *recent : RECENT_BOOKS.getDataFromBook(bookPath);

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
  writeRecord(record, out);
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
      bool skipped = false;
      valid = applyBook(record, commit, skipped);
      if (valid && skipped) {
        result.skipped++;
      } else if (valid) {
        result.books++;
      }
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
