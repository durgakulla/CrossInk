#include "DailyReadingMinutes.h"

#include <HalStorage.h>
#include <Logging.h>
#include <Memory.h>

#include <algorithm>
#include <cstring>
#include <limits>
#include <string>

namespace {
constexpr char DAILY_READING_PATH[] = "/.crosspoint/daily_reading.bin";
constexpr char DAILY_READING_TMP_PATH[] = "/.crosspoint/daily_reading.bin.tmp";
constexpr char DAILY_READING_BAK_PATH[] = "/.crosspoint/daily_reading.bin.bak";
constexpr uint8_t DAILY_READING_VERSION = 1;
constexpr size_t HEADER_SIZE = 5;
constexpr size_t FILE_SIZE = HEADER_SIZE + DailyReadingMinutes::DAYS * 4;
// Entries are streamed through a small chunk so neither load nor save needs a
// full-file buffer on the stack.
constexpr size_t ENTRIES_PER_CHUNK = 16;

void writeLe32(uint8_t* out, const uint32_t value) {
  out[0] = value & 0xFF;
  out[1] = (value >> 8) & 0xFF;
  out[2] = (value >> 16) & 0xFF;
  out[3] = (value >> 24) & 0xFF;
}

uint32_t readLe32(const uint8_t* in) {
  return static_cast<uint32_t>(in[0]) | (static_cast<uint32_t>(in[1]) << 8) | (static_cast<uint32_t>(in[2]) << 16) |
         (static_cast<uint32_t>(in[3]) << 24);
}
}  // namespace

uint32_t DailyReadingMinutes::secondsForDay(const uint32_t dayIndex) const {
  if (empty() || dayIndex > anchorDay) return 0;
  const uint32_t delta = anchorDay - dayIndex;
  return delta < DAYS ? seconds[delta] : 0;
}

void DailyReadingMinutes::addDaySeconds(const uint32_t dayIndex, const uint32_t secondsToAdd) {
  if (secondsToAdd == 0) return;
  if (empty()) {
    anchorDay = dayIndex;
    seconds.fill(0);
  } else if (dayIndex > anchorDay) {
    const uint32_t shift = dayIndex - anchorDay;
    if (shift >= DAYS) {
      seconds.fill(0);
    } else {
      std::move_backward(seconds.begin(), seconds.end() - shift, seconds.end());
      std::fill(seconds.begin(), seconds.begin() + shift, 0);
    }
    anchorDay = dayIndex;
  }

  const uint32_t delta = anchorDay - dayIndex;
  if (delta >= DAYS) return;
  const uint32_t room = std::numeric_limits<uint32_t>::max() - seconds[delta];
  seconds[delta] += std::min(room, secondsToAdd);
}

void DailyReadingMinutes::recordSpan(const ReadingStatsDateTime& localStart, const uint32_t spanSeconds) {
  if (!localStart.isValid() || spanSeconds == 0) return;

  ReadingStatsDateTime cursor = localStart;
  uint32_t remaining = spanSeconds;
  while (remaining > 0) {
    const uint32_t secondsUntilMidnight =
        (24u * 3600u) - (static_cast<uint32_t>(cursor.hour) * 3600u + static_cast<uint32_t>(cursor.minute) * 60u +
                         static_cast<uint32_t>(cursor.second));
    const uint32_t segment = std::min(remaining, secondsUntilMidnight);
    addDaySeconds(readingStatsDayIndex(cursor.date), segment);
    remaining -= segment;
    addSecondsToReadingStatsDateTime(cursor, segment);
  }
}

bool DailyReadingMinutes::load(DailyReadingMinutes& out) {
  out.anchorDay = 0;
  out.seconds.fill(0);
  // A save interrupted between its two renames leaves only the backup.
  if (!Storage.exists(DAILY_READING_PATH) && Storage.exists(DAILY_READING_BAK_PATH) &&
      !Storage.rename(DAILY_READING_BAK_PATH, DAILY_READING_PATH)) {
    LOG_ERR("DAILY", "Could not restore daily reading log backup");
  }
  if (!Storage.exists(DAILY_READING_PATH)) return false;

  FsFile file;
  if (!Storage.openFileForRead("DAILY", DAILY_READING_PATH, file)) return false;
  if (file.fileSize() != FILE_SIZE) {
    LOG_ERR("DAILY", "Ignoring daily reading log with unexpected size: %u", static_cast<unsigned>(file.fileSize()));
    file.close();
    return false;
  }

  uint8_t header[HEADER_SIZE];
  if (file.read(header, sizeof(header)) != static_cast<int>(sizeof(header)) || header[0] != DAILY_READING_VERSION) {
    LOG_ERR("DAILY", "Ignoring unreadable daily reading log");
    file.close();
    return false;
  }

  uint8_t chunk[ENTRIES_PER_CHUNK * 4];
  for (size_t index = 0; index < DAYS; index += ENTRIES_PER_CHUNK) {
    const size_t count = std::min(ENTRIES_PER_CHUNK, DAYS - index);
    if (file.read(chunk, count * 4) != static_cast<int>(count * 4)) {
      LOG_ERR("DAILY", "Short read in daily reading log");
      file.close();
      out.seconds.fill(0);
      return false;
    }
    for (size_t i = 0; i < count; ++i) {
      out.seconds[index + i] = readLe32(chunk + i * 4);
    }
  }
  file.close();
  out.anchorDay = readLe32(header + 1);
  return true;
}

bool DailyReadingMinutes::save() const {
  if (Storage.exists(DAILY_READING_TMP_PATH) && !Storage.remove(DAILY_READING_TMP_PATH)) {
    LOG_ERR("DAILY", "Could not remove stale daily reading temp file");
    return false;
  }

  FsFile file;
  if (!Storage.openFileForWrite("DAILY", DAILY_READING_TMP_PATH, file)) {
    LOG_ERR("DAILY", "Could not write daily reading temp file");
    return false;
  }

  uint8_t header[HEADER_SIZE];
  header[0] = DAILY_READING_VERSION;
  writeLe32(header + 1, anchorDay);
  bool ok = file.write(header, sizeof(header)) == sizeof(header);

  uint8_t chunk[ENTRIES_PER_CHUNK * 4];
  for (size_t index = 0; ok && index < DAYS; index += ENTRIES_PER_CHUNK) {
    const size_t count = std::min(ENTRIES_PER_CHUNK, DAYS - index);
    for (size_t i = 0; i < count; ++i) {
      writeLe32(chunk + i * 4, seconds[index + i]);
    }
    ok = file.write(chunk, count * 4) == count * 4;
  }

  if (!ok || !file.sync()) {
    LOG_ERR("DAILY", "Failed to write daily reading temp file");
    file.close();
    Storage.remove(DAILY_READING_TMP_PATH);
    return false;
  }
  if (!file.close()) {
    LOG_ERR("DAILY", "Failed to close daily reading temp file");
    Storage.remove(DAILY_READING_TMP_PATH);
    return false;
  }

  // FAT rename cannot overwrite, so move the old log aside first and put it
  // back if the new one cannot be published.
  if (Storage.exists(DAILY_READING_BAK_PATH) && !Storage.remove(DAILY_READING_BAK_PATH)) {
    LOG_ERR("DAILY", "Could not remove old daily reading backup");
    Storage.remove(DAILY_READING_TMP_PATH);
    return false;
  }
  if (Storage.exists(DAILY_READING_PATH) && !Storage.rename(DAILY_READING_PATH, DAILY_READING_BAK_PATH)) {
    LOG_ERR("DAILY", "Could not back up daily reading log");
    Storage.remove(DAILY_READING_TMP_PATH);
    return false;
  }
  if (!Storage.rename(DAILY_READING_TMP_PATH, DAILY_READING_PATH)) {
    LOG_ERR("DAILY", "Could not publish daily reading log");
    if (Storage.exists(DAILY_READING_BAK_PATH)) Storage.rename(DAILY_READING_BAK_PATH, DAILY_READING_PATH);
    Storage.remove(DAILY_READING_TMP_PATH);
    return false;
  }
  if (Storage.exists(DAILY_READING_BAK_PATH)) Storage.remove(DAILY_READING_BAK_PATH);
  return true;
}

bool DailyReadingMinutes::addSpan(const ReadingStatsDateTime& localStart, const uint32_t spanSeconds) {
  if (!localStart.isValid() || spanSeconds == 0) return false;

  auto log = makeUniqueNoThrow<DailyReadingMinutes>();
  if (!log) {
    LOG_ERR("DAILY", "OOM loading daily reading log");
    return false;
  }
  load(*log);
  log->recordSpan(localStart, spanSeconds);
  return log->save();
}

void DailyReadingMinutes::recordSession(const uint32_t sessionSeconds, const ReadingStatsDateTime* sessionStart) {
  if (sessionSeconds < 10 || !sessionStart) return;
  addSpan(*sessionStart, sessionSeconds);
}

bool DailyReadingMinutes::reset() {
  if (Storage.exists(DAILY_READING_TMP_PATH)) Storage.remove(DAILY_READING_TMP_PATH);
  if (Storage.exists(DAILY_READING_BAK_PATH) && !Storage.remove(DAILY_READING_BAK_PATH)) {
    LOG_ERR("DAILY", "Could not delete daily reading backup");
    return false;
  }
  if (!Storage.exists(DAILY_READING_PATH)) return true;
  if (!Storage.remove(DAILY_READING_PATH)) {
    LOG_ERR("DAILY", "Could not delete daily reading log");
    return false;
  }
  return true;
}
