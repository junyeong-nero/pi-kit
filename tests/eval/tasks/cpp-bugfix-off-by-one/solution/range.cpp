#include "range.h"
int sum_range(int first, int last) {
  int total = 0;
  for (int i = first; i <= last; ++i) total += i;
  return total;
}
