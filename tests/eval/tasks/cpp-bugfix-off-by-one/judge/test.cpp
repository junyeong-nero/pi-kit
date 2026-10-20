#include <cassert>
#include "range.h"
int main() {
  assert(sum_range(1, 3) == 6);
  assert(sum_range(5, 5) == 5);
  assert(sum_range(4, 2) == 0);
  return 0;
}
