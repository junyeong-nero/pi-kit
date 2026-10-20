#pragma once
#include <stdexcept>
#include <vector>

class IntStack {
 public:
  void push(int value) { items_.push_back(value); }
  int pop() {
    if (items_.empty()) throw std::out_of_range("empty stack");
    int value = items_.back();
    items_.pop_back();
    return value;
  }
  bool empty() const { return items_.empty(); }
  size_t size() const { return items_.size(); }

 private:
  std::vector<int> items_;
};
