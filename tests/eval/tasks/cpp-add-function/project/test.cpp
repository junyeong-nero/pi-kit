#include <cassert>
#include <cmath>
#include <vector>
#include "stats.h"
int main() {
  assert(total({1, 2, 3}) == 6);
  assert(std::fabs(mean({1, 2, 3, 4}) - 2.5) < 1e-9);
  assert(mean({}) == 0.0);
  return 0;
}
