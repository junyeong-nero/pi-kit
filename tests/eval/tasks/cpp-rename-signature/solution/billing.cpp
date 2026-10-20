#include "billing.h"
#include "pricing.h"
int billing_total() { return compute_cost(4, 250) + compute_cost(2, 250); }
