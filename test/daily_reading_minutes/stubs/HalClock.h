#pragma once

#include <cstdint>

// Host stand-in for the RTC: tests never read the live clock.
struct HostHalClock {
  bool getDateTime(uint16_t&, uint8_t&, uint8_t&, uint8_t&, uint8_t&) const { return false; }
};

inline HostHalClock halClock;
