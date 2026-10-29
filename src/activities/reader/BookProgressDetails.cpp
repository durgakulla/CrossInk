#include "BookProgressDetails.h"

#include <Epub.h>
#include <FsHelpers.h>
#include <HalStorage.h>
#include <Logging.h>
#include <Memory.h>
#include <Xtc.h>

#include <algorithm>
#include <cctype>
#include <cstring>

#include "BookReadingStats.h"
#include "EpubReaderUtils.h"

namespace {

constexpr size_t kMaxChapters = std::tuple_size<decltype(BookProgressDetails::chapterTicks)>::value;
constexpr size_t kMaxAnchorLength = 48;
constexpr uint8_t kTickCacheVersion = 1;
constexpr char kTickCacheFile[] = "/chapter_ticks.bin";

struct ChapterEntry {
  int16_t spineIndex = -1;
  char anchor[kMaxAnchorLength] = {};  // Empty: the chapter starts with its file
  float spineRead = 0.0f;              // Where in its file the chapter starts, 0-1
};

// Finds where elements with the given ids start in an HTML stream, as byte
// offsets. Tags longer than kMaxTagLength are skipped. Stops the stream once
// every id is found.
class AnchorOffsetScanner final : public Print {
 public:
  AnchorOffsetScanner(ChapterEntry* entries, const size_t count, uint32_t* offsets)
      : entries(entries), count(count), offsets(offsets) {
    for (size_t i = 0; i < count; ++i) {
      offsets[i] = UINT32_MAX;
      if (entries[i].anchor[0] != '\0') ++remaining;
    }
  }

  size_t write(const uint8_t data) override { return write(&data, 1); }

  size_t write(const uint8_t* buffer, const size_t size) override {
    for (size_t index = 0; index < size; ++index) {
      if (remaining == 0) return index;
      const char c = static_cast<char>(buffer[index]);
      if (c == '<') {
        insideTag = true;
        tagStart = position;
        tagLength = 0;
      } else if (insideTag && c == '>') {
        insideTag = false;
        if (tagLength < kMaxTagLength) checkTag();
      } else if (insideTag && tagLength < kMaxTagLength) {
        tag[tagLength++] = c;
      } else if (insideTag) {
        tagLength = kMaxTagLength;  // Too long to check
      }
      ++position;
    }
    return size;
  }

 private:
  static constexpr size_t kMaxTagLength = 192;

  ChapterEntry* entries;
  size_t count;
  uint32_t* offsets;
  size_t remaining = 0;
  char tag[kMaxTagLength + 1] = {};
  size_t tagLength = 0;
  uint32_t tagStart = 0;
  uint32_t position = 0;
  bool insideTag = false;

  // Matches an id="..." (or id='...' or id=...) attribute against the ids
  // still being looked for.
  void checkTag() {
    tag[tagLength] = '\0';
    for (const char* attr = tag; (attr = std::strstr(attr, "id")) != nullptr; attr += 2) {
      const char preceding = attr == tag ? '\0' : attr[-1];
      if (preceding != ' ' && preceding != '\t' && preceding != '\r' && preceding != '\n') continue;
      const char* value = attr + 2;
      while (std::isspace(static_cast<unsigned char>(*value))) value++;
      if (*value++ != '=') continue;
      while (std::isspace(static_cast<unsigned char>(*value))) value++;
      const char quote = *value == '\'' || *value == '"' ? *value++ : '\0';
      size_t length = 0;
      while (value[length] != '\0' &&
             (quote ? value[length] != quote : !std::isspace(static_cast<unsigned char>(value[length])))) {
        ++length;
      }
      for (size_t i = 0; i < count; ++i) {
        if (offsets[i] != UINT32_MAX || entries[i].anchor[0] == '\0') continue;
        if (std::strlen(entries[i].anchor) == length && std::strncmp(entries[i].anchor, value, length) == 0) {
          offsets[i] = tagStart;
          --remaining;
        }
      }
      return;
    }
  }
};

bool readCachedTicks(const std::string& cachePath, BookProgressDetails& book) {
  FsFile file;
  if (!Storage.exists((cachePath + kTickCacheFile).c_str()) ||
      !Storage.openFileForRead("BPD", cachePath + kTickCacheFile, file)) {
    return false;
  }
  uint8_t header[2] = {};
  bool ok = file.read(header, sizeof(header)) == sizeof(header) && header[0] == kTickCacheVersion &&
            header[1] <= kMaxChapters;
  if (ok) {
    const size_t bytes = header[1] * sizeof(uint16_t);
    ok =
        bytes == 0 || file.read(reinterpret_cast<uint8_t*>(book.chapterTicks.data()), bytes) == static_cast<int>(bytes);
    book.chapterTickCount = ok ? header[1] : 0;
  }
  file.close();
  return ok;
}

void writeCachedTicks(const std::string& cachePath, const BookProgressDetails& book) {
  FsFile file;
  if (!Storage.openFileForWrite("BPD", cachePath + kTickCacheFile, file)) return;
  const uint8_t header[2] = {kTickCacheVersion, book.chapterTickCount};
  file.write(header, sizeof(header));
  file.write(reinterpret_cast<const uint8_t*>(book.chapterTicks.data()), book.chapterTickCount * sizeof(uint16_t));
  file.close();
}

// Where each chapter starts, in thousandths of the book. Chapters are one TOC
// level: the shallowest with at least two entries, so a book whose contents
// sit under a single title entry still gets its chapters; nested sections
// would crowd the bar. A chapter that starts partway through a file (a TOC
// anchor) is found by scanning that file once. The result is cached in the
// book's cache folder; a scan that fails (e.g. too little memory to inflate
// the file) falls back to the file's start and is retried next time.
void loadChapterTicks(const Epub& epub, BookProgressDetails& book) {
  const std::string& cachePath = epub.getCachePath();
  if (readCachedTicks(cachePath, book)) return;

  const int tocCount = epub.getTocItemsCount();
  constexpr uint8_t kMaxCountedLevel = 8;
  std::array<uint8_t, kMaxCountedLevel> levelCounts{};
  for (int i = 0; i < tocCount; ++i) {
    const uint8_t level = epub.getTocItem(i).level;
    if (level < kMaxCountedLevel && levelCounts[level] < UINT8_MAX) ++levelCounts[level];
  }
  uint8_t chapterLevel = UINT8_MAX;
  for (uint8_t level = 0; level < kMaxCountedLevel; ++level) {
    if (levelCounts[level] == 0) continue;
    if (chapterLevel == UINT8_MAX) chapterLevel = level;  // Fallback: the shallowest level present
    if (levelCounts[level] >= 2) {
      chapterLevel = level;
      break;
    }
  }

  // 64 entries with their anchors are ~3 KB, too much for the stack.
  auto entries = makeUniqueNoThrow<std::array<ChapterEntry, kMaxChapters>>();
  if (!entries) {
    LOG_ERR("BPD", "OOM loading chapter ticks");
    return;
  }
  size_t entryCount = 0;
  for (int i = 0; i < tocCount && entryCount < kMaxChapters; ++i) {
    const auto item = epub.getTocItem(i);
    if (item.level != chapterLevel || item.spineIndex < 0) continue;
    ChapterEntry& entry = (*entries)[entryCount++];
    entry.spineIndex = item.spineIndex;
    if (item.anchor.size() < kMaxAnchorLength) {
      std::memcpy(entry.anchor, item.anchor.c_str(), item.anchor.size() + 1);
    }
  }

  // Scan each file holding anchored chapters once, for all of its anchors.
  bool complete = true;
  std::array<uint32_t, kMaxChapters> offsets{};
  for (size_t first = 0; first < entryCount;) {
    size_t last = first;
    bool anchored = false;
    while (last < entryCount && (*entries)[last].spineIndex == (*entries)[first].spineIndex) {
      anchored = anchored || (*entries)[last].anchor[0] != '\0';
      ++last;
    }
    if (anchored) {
      const std::string& href = epub.getSpineItem((*entries)[first].spineIndex).href;
      size_t itemSize = 0;
      AnchorOffsetScanner scanner(&(*entries)[first], last - first, &offsets[first]);
      if (epub.getItemSize(href, &itemSize) && itemSize > 0 &&
          epub.readItemContentsToStream(href, scanner, 512, /*allowEarlyStop=*/true)) {
        for (size_t i = first; i < last; ++i) {
          if (offsets[i] != UINT32_MAX) {
            (*entries)[i].spineRead = std::min(1.0f, static_cast<float>(offsets[i]) / static_cast<float>(itemSize));
          }
        }
      } else {
        complete = false;
      }
    }
    first = last;
  }

  // Ticks too close to the previous one are dropped.
  int lastPermille = 0;
  for (size_t i = 0; i < entryCount; ++i) {
    const ChapterEntry& entry = (*entries)[i];
    const int permille = static_cast<int>(epub.calculateProgress(entry.spineIndex, entry.spineRead) * 1000.0f + 0.5f);
    if (permille - lastPermille < kBookProgressMinChapterTickPermille || permille >= 1000) continue;
    book.chapterTicks[book.chapterTickCount++] = static_cast<uint16_t>(permille);
    lastPermille = permille;
  }
  if (complete) writeCachedTicks(cachePath, book);
}

// The reader's stable page for an EPUB (when the book has stable page numbers)
// or its page for an XTC, the pages left in the current EPUB chapter, and where
// each EPUB chapter starts. Unknown values stay 0.
void loadBookPosition(const std::string& path, BookProgressDetails& book, uint32_t& chapterPagesLeft) {
  chapterPagesLeft = 0;
  if (FsHelpers::hasEpubExtension(path)) {
    Epub epub(path, "/.crosspoint");
    if (!epub.load(false, true, Epub::XLocationLoadMode::Immediate)) {
      return;
    }
    loadChapterTicks(epub, book);

    EpubReaderUtils::Progress progress;
    if (!EpubReaderUtils::loadProgress(epub, progress, "BPD") || !progress.hasPageCount || progress.pageCount <= 0) {
      return;
    }
    if (progress.pageNumber + 1 < progress.pageCount) {
      chapterPagesLeft = static_cast<uint32_t>(progress.pageCount - (progress.pageNumber + 1));
    }
    if (epub.hasStablePageNumbers()) {
      // Same section progress the reader uses for its stable page.
      const float sectionProgress = static_cast<float>(progress.pageNumber) / static_cast<float>(progress.pageCount);
      epub.resolveReferencePage(progress.spineIndex, sectionProgress, book.page, book.pageCount);
    }
    return;
  }
  if (FsHelpers::hasXtcExtension(path)) {
    Xtc xtc(path, "/.crosspoint");
    if (!xtc.load()) {
      return;
    }
    FsFile file;
    if (!Storage.openFileForRead("BPD", xtc.getCachePath() + "/progress.bin", file)) {
      return;
    }
    uint8_t data[4];
    const int bytesRead = file.read(data, sizeof(data));
    file.close();
    book.pageCount = xtc.getPageCount();
    if (bytesRead != 4 || book.pageCount == 0) {
      book.pageCount = 0;
      return;
    }
    const uint32_t current = static_cast<uint32_t>(data[0]) | (static_cast<uint32_t>(data[1]) << 8) |
                             (static_cast<uint32_t>(data[2]) << 16) | (static_cast<uint32_t>(data[3]) << 24);
    book.page = std::min(current + 1, book.pageCount);
  }
}

}  // namespace

void loadBookProgressDetails(const std::string& path, const BookReadingStats& stats, const float progressPercent,
                             const ReadingStatsDateTime* now, BookProgressDetails& details) {
  details = BookProgressDetails{};
  details.progressPercent = progressPercent;
  details.readingSeconds = stats.totalReadingSeconds;
  details.pagesTurned = stats.totalPagesTurned;
  if (progressPercent >= 0.0f) {
    stats.estimateTimeLeft(progressPercent, details.timeLeftSeconds);
  }
  details.startDate = stats.startDate;
  details.finished = stats.isCompleted && stats.finishedDate.isValid();
  if (details.finished) {
    details.endDate = stats.finishedDate;
  } else if (details.timeLeftSeconds > 0 && now) {
    stats.estimateFinishDate(*now, details.timeLeftSeconds, details.endDate);
  }
  uint32_t chapterPagesLeft = 0;
  loadBookPosition(path, details, chapterPagesLeft);
  // The reader's stored pace needs a few page samples before it is trusted.
  if (stats.avgSecondsPerForwardPage > 0 && stats.paceSampleCount >= 3) {
    details.chapterTimeLeftSeconds = chapterPagesLeft * stats.avgSecondsPerForwardPage;
  }
}
