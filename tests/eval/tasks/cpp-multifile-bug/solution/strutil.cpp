#include "strutil.h"
std::string trim(const std::string& text) {
  const char* ws = " \t";
  size_t begin = text.find_first_not_of(ws);
  if (begin == std::string::npos) return "";
  size_t end = text.find_last_not_of(ws);
  return text.substr(begin, end - begin + 1);
}
