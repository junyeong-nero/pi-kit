#include <cassert>
#include <string>
#include "billing.h"
#include "pricing.h"
#include "report.h"
int main() {
  assert(compute_cost(3, 10) == 30);
  assert(billing_total() == 4 * 250 + 2 * 250);
  assert(report_line() == "units=4 cost=1000");
  return 0;
}
