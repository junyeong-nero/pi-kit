#include <cassert>
#include <stdexcept>
#include "stack.h"
int main() {
  IntStack s;
  assert(s.empty());
  s.push(1);
  s.push(2);
  assert(s.size() == 2);
  assert(s.pop() == 2);
  assert(s.pop() == 1);
  bool thrown = false;
  try { s.pop(); } catch (const std::out_of_range&) { thrown = true; }
  assert(thrown);
  return 0;
}
