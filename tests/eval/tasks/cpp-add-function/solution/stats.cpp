#include "stats.h"
int total(const std::vector<int>& values) {
  int sum = 0;
  for (int v : values) sum += v;
  return sum;
}
double mean(const std::vector<int>& values) {
  if (values.empty()) return 0.0;
  return static_cast<double>(total(values)) / values.size();
}
