#include <DailyReadingMinutes.h>
#include <HalStorage.h>
#include <gtest/gtest.h>

#include <memory>

namespace {
constexpr char LOG_PATH[] = "/.crosspoint/daily_reading.bin";

ReadingStatsDateTime at(const uint16_t year, const uint8_t month, const uint8_t day, const uint8_t hour,
                        const uint8_t minute) {
  ReadingStatsDateTime dt;
  dt.date = {year, month, day};
  dt.hour = hour;
  dt.minute = minute;
  return dt;
}

uint32_t dayOf(const uint16_t year, const uint8_t month, const uint8_t day) {
  return readingStatsDayIndex(ReadingStatsDate{year, month, day});
}
}  // namespace

class DailyReadingMinutesTest : public testing::Test {
 protected:
  void SetUp() override { Storage.reset(); }
  std::unique_ptr<DailyReadingMinutes> log = std::make_unique<DailyReadingMinutes>();
};

TEST_F(DailyReadingMinutesTest, AccumulatesSecondsOnTheSameDay) {
  log->recordSpan(at(2026, 10, 20, 9, 0), 600);
  log->recordSpan(at(2026, 10, 20, 21, 0), 300);

  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 20)), 900U);
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 19)), 0U);
}

TEST_F(DailyReadingMinutesTest, SplitsSpansAtMidnight) {
  log->recordSpan(at(2026, 10, 20, 23, 50), 30 * 60);

  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 20)), 10U * 60U);
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 21)), 20U * 60U);
  EXPECT_EQ(log->anchorDay, dayOf(2026, 10, 21));
}

TEST_F(DailyReadingMinutesTest, ShiftsOlderDaysWhenANewerDayArrives) {
  log->recordSpan(at(2026, 10, 1, 8, 0), 120);
  log->recordSpan(at(2026, 10, 23, 8, 0), 240);

  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 1)), 120U);
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 23)), 240U);
}

TEST_F(DailyReadingMinutesTest, KeepsLateEntriesForOlderDaysInsideTheWindow) {
  log->recordSpan(at(2026, 10, 23, 8, 0), 240);
  log->recordSpan(at(2026, 10, 10, 8, 0), 60);

  EXPECT_EQ(log->anchorDay, dayOf(2026, 10, 23));
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 10)), 60U);
}

TEST_F(DailyReadingMinutesTest, DropsDaysOlderThanTheWindow) {
  const uint32_t oldDay = dayOf(2026, 1, 1);
  log->addDaySeconds(oldDay, 500);
  log->addDaySeconds(oldDay + DailyReadingMinutes::DAYS - 1, 10);
  EXPECT_EQ(log->secondsForDay(oldDay), 500U);

  log->addDaySeconds(oldDay + DailyReadingMinutes::DAYS, 10);
  EXPECT_EQ(log->secondsForDay(oldDay), 0U);

  log->addDaySeconds(oldDay - 400, 99);
  EXPECT_EQ(log->secondsForDay(oldDay - 400), 0U);
}

TEST_F(DailyReadingMinutesTest, SaveAndLoadRoundTrip) {
  log->recordSpan(at(2026, 10, 20, 9, 0), 1800);
  log->recordSpan(at(2026, 6, 1, 9, 0), 45);
  ASSERT_TRUE(log->save());
  EXPECT_FALSE(Storage.exists((std::string(LOG_PATH) + ".tmp").c_str()));

  auto loaded = std::make_unique<DailyReadingMinutes>();
  ASSERT_TRUE(DailyReadingMinutes::load(*loaded));
  EXPECT_EQ(loaded->anchorDay, log->anchorDay);
  EXPECT_EQ(loaded->seconds, log->seconds);
}

TEST_F(DailyReadingMinutesTest, AddSpanPersistsAcrossCalls) {
  ASSERT_TRUE(DailyReadingMinutes::addSpan(at(2026, 10, 22, 7, 0), 600));
  ASSERT_TRUE(DailyReadingMinutes::addSpan(at(2026, 10, 22, 19, 0), 900));

  ASSERT_TRUE(DailyReadingMinutes::load(*log));
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 22)), 1500U);
}

TEST_F(DailyReadingMinutesTest, RecordSessionIgnoresShortOrUndatedSessions) {
  const ReadingStatsDateTime start = at(2026, 10, 22, 7, 0);
  DailyReadingMinutes::recordSession(9, &start);
  DailyReadingMinutes::recordSession(600, nullptr);
  EXPECT_FALSE(Storage.exists(LOG_PATH));

  DailyReadingMinutes::recordSession(10, &start);
  ASSERT_TRUE(DailyReadingMinutes::load(*log));
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 22)), 10U);
}

TEST_F(DailyReadingMinutesTest, ResetDeletesTheLog) {
  ASSERT_TRUE(DailyReadingMinutes::addSpan(at(2026, 10, 22, 7, 0), 600));
  EXPECT_TRUE(DailyReadingMinutes::reset());
  EXPECT_FALSE(Storage.exists(LOG_PATH));
  EXPECT_FALSE(DailyReadingMinutes::load(*log));
  EXPECT_TRUE(log->empty());
  EXPECT_TRUE(DailyReadingMinutes::reset());
}

TEST_F(DailyReadingMinutesTest, KeepsPreviousLogWhenPublishFails) {
  ASSERT_TRUE(DailyReadingMinutes::addSpan(at(2026, 10, 22, 7, 0), 600));
  Storage.failNextRenameFrom(std::string(LOG_PATH) + ".tmp");

  EXPECT_FALSE(DailyReadingMinutes::addSpan(at(2026, 10, 22, 8, 0), 300));
  EXPECT_FALSE(Storage.exists((std::string(LOG_PATH) + ".tmp").c_str()));

  ASSERT_TRUE(DailyReadingMinutes::load(*log));
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 22)), 600U);
}

TEST_F(DailyReadingMinutesTest, RecoversBackupAfterInterruptedSave) {
  ASSERT_TRUE(DailyReadingMinutes::addSpan(at(2026, 10, 22, 7, 0), 600));
  ASSERT_TRUE(Storage.rename(LOG_PATH, (std::string(LOG_PATH) + ".bak").c_str()));

  ASSERT_TRUE(DailyReadingMinutes::load(*log));
  EXPECT_EQ(log->secondsForDay(dayOf(2026, 10, 22)), 600U);
  EXPECT_TRUE(Storage.exists(LOG_PATH));
}

TEST(ReadingHistoryLookupTest, ReportsMarkedDaysRelativeToTheAnchor) {
  uint32_t anchor = 0;
  std::array<uint8_t, READING_HISTORY_BYTES> bits{};
  const uint32_t day = dayOf(2026, 10, 20);
  markReadingHistoryDay(anchor, bits, day);
  markReadingHistoryDay(anchor, bits, day + 2);

  EXPECT_TRUE(isReadingHistoryDaySet(anchor, bits, day));
  EXPECT_FALSE(isReadingHistoryDaySet(anchor, bits, day + 1));
  EXPECT_TRUE(isReadingHistoryDaySet(anchor, bits, day + 2));
  EXPECT_FALSE(isReadingHistoryDaySet(anchor, bits, day + 3));
  EXPECT_FALSE(isReadingHistoryDaySet(0, std::array<uint8_t, READING_HISTORY_BYTES>{}, day));
}

TEST(ReadingHistoryStreakTest, IgnoresDaysDatedAfterToday) {
  uint32_t anchor = 0;
  std::array<uint8_t, READING_HISTORY_BYTES> bits{};
  const ReadingStatsDate today{2026, 10, 23};
  const uint32_t todayDay = readingStatsDayIndex(today);
  // Ten days up to today, plus one recorded a day ahead (e.g. before a clock fix).
  for (uint32_t day = todayDay - 9; day <= todayDay + 1; ++day) markReadingHistoryDay(anchor, bits, day);

  EXPECT_EQ(computeReadingHistoryCurrentStreak(anchor, bits, &today), 10U);
}

TEST(ReadingHistoryStreakTest, KeepsYesterdaysStreakWhenTodayIsUnreadAndLaterDaysExist) {
  uint32_t anchor = 0;
  std::array<uint8_t, READING_HISTORY_BYTES> bits{};
  const ReadingStatsDate today{2026, 10, 23};
  const uint32_t todayDay = readingStatsDayIndex(today);
  for (uint32_t day = todayDay - 4; day <= todayDay - 1; ++day) markReadingHistoryDay(anchor, bits, day);
  markReadingHistoryDay(anchor, bits, todayDay + 2);

  EXPECT_EQ(computeReadingHistoryCurrentStreak(anchor, bits, &today), 4U);
}

TEST(ReadingHistoryStreakTest, CountsFromTheLatestDayWithoutADate) {
  uint32_t anchor = 0;
  std::array<uint8_t, READING_HISTORY_BYTES> bits{};
  const ReadingStatsDate today{2026, 10, 23};
  const uint32_t todayDay = readingStatsDayIndex(today);
  for (uint32_t day = todayDay - 2; day <= todayDay; ++day) markReadingHistoryDay(anchor, bits, day);

  EXPECT_EQ(computeReadingHistoryCurrentStreak(anchor, bits, &today), 3U);
  EXPECT_EQ(computeReadingHistoryCurrentStreak(anchor, bits, nullptr), 3U);
}

TEST(ReadingHistoryStreakTest, LongestStreakIgnoresDaysDatedAfterToday) {
  uint32_t anchor = 0;
  std::array<uint8_t, READING_HISTORY_BYTES> bits{};
  const ReadingStatsDate today{2026, 10, 23};
  const uint32_t todayDay = readingStatsDayIndex(today);
  for (uint32_t day = todayDay - 9; day <= todayDay + 1; ++day) markReadingHistoryDay(anchor, bits, day);

  EXPECT_EQ(computeReadingHistoryLongestStreak(anchor, bits), 11U);
  EXPECT_EQ(computeReadingHistoryLongestStreak(anchor, bits, &today), 10U);
}

TEST(ReadingHistoryStreakTest, LongestStreakKeepsOlderRunsWhenOnlyFutureDaysExistAfterThem) {
  uint32_t anchor = 0;
  std::array<uint8_t, READING_HISTORY_BYTES> bits{};
  const ReadingStatsDate today{2026, 10, 23};
  const uint32_t todayDay = readingStatsDayIndex(today);
  for (uint32_t day = todayDay - 30; day <= todayDay - 25; ++day) markReadingHistoryDay(anchor, bits, day);
  for (uint32_t day = todayDay + 1; day <= todayDay + 8; ++day) markReadingHistoryDay(anchor, bits, day);

  EXPECT_EQ(computeReadingHistoryLongestStreak(anchor, bits, &today), 6U);
}
