#pragma once
#include <string>
struct Setting {
  std::string key;
  std::string value;
};
Setting parse_setting(const std::string& line);
