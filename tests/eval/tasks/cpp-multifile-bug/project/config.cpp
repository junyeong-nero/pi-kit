#include "config.h"
#include "strutil.h"
Setting parse_setting(const std::string& line) {
  size_t pos = line.find('=');
  Setting s;
  if (pos == std::string::npos) return s;
  s.key = trim(line.substr(0, pos));
  s.value = trim(line.substr(pos + 1));
  return s;
}
