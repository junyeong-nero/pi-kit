#include "parser.h"
Entry parse_entry(const std::string& line) {
  Entry entry;
  size_t pos = line.find('=');
  if (pos == std::string::npos) return entry;
  entry.key = line.substr(0, pos);
  entry.value = line.substr(pos + 1);
  entry.valid = true;
  return entry;
}
