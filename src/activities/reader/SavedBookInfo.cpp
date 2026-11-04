#include "SavedBookInfo.h"

#include <HalStorage.h>
#include <Logging.h>

#include <algorithm>
#include <cstring>

namespace {

constexpr const char* kFileName = "/book_info.txt";
// One line each for the path, title and author.
constexpr size_t kMaxFileSize = 768;
constexpr size_t kMaxFieldLength = 250;

// Keeps a field to one line of bounded length.
std::string oneLine(const std::string& text) {
  std::string line = text.substr(0, kMaxFieldLength);
  std::replace_if(line.begin(), line.end(), [](const char c) { return c == '\n' || c == '\r'; }, ' ');
  return line;
}

}  // namespace

bool SavedBookInfo::load(const std::string& cachePath, SavedBookInfo& out) {
  out = SavedBookInfo{};
  char buffer[kMaxFileSize + 1];
  const size_t length = Storage.readFileToBuffer((cachePath + kFileName).c_str(), buffer, sizeof(buffer));
  if (length == 0) return false;
  const char* start = buffer;
  // Takes the next line, or the rest of the file without a final newline.
  const auto nextLine = [&start](std::string& field) {
    const char* end = strchr(start, '\n');
    field.assign(start, end ? end - start : strlen(start));
    start = end ? end + 1 : start + strlen(start);
  };
  nextLine(out.path);
  nextLine(out.title);
  nextLine(out.author);
  return !out.path.empty() && out.path.front() == '/';
}

bool SavedBookInfo::save(const std::string& cachePath, const std::string& path, const std::string& title,
                         const std::string& author) {
  if (cachePath.empty() || path.empty() || path.size() > kMaxFieldLength) return false;
  const std::string content = path + "\n" + oneLine(title) + "\n" + oneLine(author) + "\n";
  char existing[kMaxFileSize + 1];
  const std::string filePath = cachePath + kFileName;
  if (Storage.readFileToBuffer(filePath.c_str(), existing, sizeof(existing)) == content.size() &&
      content == existing) {
    return true;
  }
  Storage.mkdir(cachePath.c_str(), true);
  HalFile file;
  if (!Storage.openFileForWrite("BINFO", filePath, file)) {
    LOG_ERR("BINFO", "Could not write %s", filePath.c_str());
    return false;
  }
  const size_t written = file.write(reinterpret_cast<const uint8_t*>(content.data()), content.size());
  file.close();
  if (written != content.size()) {
    LOG_ERR("BINFO", "Short write to %s", filePath.c_str());
    return false;
  }
  return true;
}
