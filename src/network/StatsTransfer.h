#pragma once

#include <cstdint>
#include <string>

class Print;

// Reading stats as JSON for the USB stats commands (UsbSerialFileTransfer):
// exported with the reader's own loaders, imported through its own savers,
// so hosts never handle CrossInk's binary stats formats. Format
// "crossink-stats" version 1, documented in docs/file-formats.md.
namespace StatsTransfer {

// Writes the meta, global and daily records, one "STATS:{json}" line each.
void writeGlobalStats(Print& out);

// Writes one "STATS:{json}" book record for the book at path. Returns false,
// writing nothing, when the book has no stats or stats tracking is off for it.
bool writeBookStats(const char* path, Print& out);

// Writes one "BOOK:{json}" line describing a book file for the File Manager's
// library view: title, author, progress, time read and the size of its saved
// cover thumbnail (0 when it has none). Returns false for non-book files.
bool writeLibraryEntry(const char* path, Print& out);

// The book's best saved cover thumbnail (the largest non-letterboxed one), or
// an empty string when the reader hasn't made one yet. Sets *size to its byte
// size when given.
std::string coverThumbPath(const char* path, uint32_t* size = nullptr);

struct ImportResult {
  bool ok = false;
  const char* error = "";  // Set when ok is false
  bool global = false;
  bool daily = false;
  uint16_t books = 0;
  uint16_t skipped = 0;  // Books whose file is not on the card
};

// Applies a JSON Lines stats backup (the records above, without the "STATS:"
// prefix, starting with the meta record) and deletes the file afterwards.
ImportResult importStatsFile(const char* path);

}  // namespace StatsTransfer
