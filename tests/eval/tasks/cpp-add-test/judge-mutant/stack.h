#pragma once
#include <stdexcept>
#include <vector>

class IntStack {
 public:
  void push(int value) { items_.push_back(value); }
  int pop() {
    int value = items_.empty() ? 0 : items_.back();
    if (!items_.empty()) items_.pop_back();
    return value;
  }
  bool empty() const { return items_.empty(); }
  size_t size() const { return items_.size(); }

 private:
  std::vector<int> items_;
};
