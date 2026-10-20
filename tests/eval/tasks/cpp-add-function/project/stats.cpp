#include "stats.h"
int total(const std::vector<int>& values) {
  int sum = 0;
  for (int v : values) sum += v;
  return sum;
}
