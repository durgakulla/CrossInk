#pragma once
#include <string>

// Which book a cache folder belongs to: its path, title and author, kept in
// cachePath/book_info.txt beside the book's stats. Cache folders are named
// from a hash of the path, and the title lives in the layout cache that is
// cleared when the book is deleted, so this is what lets the Reading Stats
// page list a deleted book's stats.
struct SavedBookInfo {
  std::string path;
  std::string title;
  std::string author;

  // False when the file is missing or has no path.
  static bool load(const std::string& cachePath, SavedBookInfo& out);
  // Writes the file only when it would change, so calling this each time a
  // book opens costs a small read.
  static bool save(const std::string& cachePath, const std::string& path, const std::string& title,
                   const std::string& author);
};
