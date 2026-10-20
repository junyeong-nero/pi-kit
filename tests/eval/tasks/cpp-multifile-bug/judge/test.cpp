#include <cassert>
#include "config.h"
int main() {
  Setting s = parse_setting("  timeout =  30  ");
  assert(s.key == "timeout");
  assert(s.value == "30");
  assert(parse_setting("mode=fast").value == "fast");
  return 0;
}
