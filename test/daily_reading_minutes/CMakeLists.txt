add_executable(DailyReadingMinutesTest
  DailyReadingMinutesTest.cpp
  ${REPO_ROOT}/src/activities/reader/DailyReadingMinutes.cpp
  ${REPO_ROOT}/src/activities/reader/ReadingStatsUtils.cpp
)

target_include_directories(DailyReadingMinutesTest PRIVATE
  ${CMAKE_CURRENT_SOURCE_DIR}/stubs
  ${REPO_ROOT}/test/book_reading_stats_atomic/stubs
  ${REPO_ROOT}/lib/Memory
  ${REPO_ROOT}/src/activities/reader
)

target_link_libraries(DailyReadingMinutesTest PRIVATE
  crosspoint_test_common
  GTest::gtest_main
)

gtest_discover_tests(DailyReadingMinutesTest)
