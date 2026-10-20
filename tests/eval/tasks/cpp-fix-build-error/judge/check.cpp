#include <cassert>
#include "parser.h"
int main() {
  Entry e = parse_entry("name=pi");
  assert(e.key == "name");
  assert(e.value == "pi");
  assert(!parse_entry("novalue").valid);
  return 0;
}
