#pragma once
#include <string>
struct Entry {
  std::string key;
  std::string value;
  bool valid = false;
};
Entry parse_entry(const std::string& line);
