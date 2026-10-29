#pragma once

#include "activities/reader/BookProgressDetails.h"

class GfxRenderer;

// Detailed book progress bar, shared by the Reading Heatmap sleep screen and
// the Minimal Carousel home screen: time read, chapter time left and book time
// left above the bar; pace, percent and page below it; chapter starts marked
// on the bar. Missing values are left out.

// Height of the label row, bar and label row together.
int bookProgressBarHeight(const GfxRenderer& renderer);
// Distance from the top of the block to the middle of the bar.
int bookProgressBarMiddle(const GfxRenderer& renderer);
void drawBookProgressBar(const GfxRenderer& renderer, const BookProgressDetails& book, int x, int y, int width);
// The start date centered between leftEdge and the bar, and the finish date
// (marked "(est.)" when estimated) between the bar and rightEdge, each as day,
// year and note lines centered on the bar's middle. y is the block's top.
void drawBookProgressDates(const GfxRenderer& renderer, const BookProgressDetails& book, int leftEdge, int barX,
                           int barWidth, int rightEdge, int y);
