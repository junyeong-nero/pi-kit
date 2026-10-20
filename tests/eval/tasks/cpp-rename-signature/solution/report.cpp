#include "report.h"
#include "pricing.h"
std::string report_line() {
  int units = 4;
  return "units=" + std::to_string(units) + " cost=" + std::to_string(compute_cost(units, 250));
}
