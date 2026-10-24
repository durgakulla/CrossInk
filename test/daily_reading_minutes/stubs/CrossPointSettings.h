#pragma once

#include <cstdint>

// Only the field ReadingStatsUtils.cpp reads.
struct HostCrossPointSettings {
  uint8_t clockUtcOffsetQ = 48;
};

inline HostCrossPointSettings SETTINGS;
