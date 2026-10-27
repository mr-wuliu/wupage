"""OpenCV.js bindings used by @paddleocr/paddleocr-js 0.4.2.

Mat, MatVector, Rect, RotatedRect, Scalar, Size, constants and browser image
helpers are supplied by OpenCV's handwritten core bindings and helpers.js.
"""

core = {"": ["mean", "rotate"]}
imgproc = {"": [
    "cvtColor", "fillPoly", "findContours", "getPerspectiveTransform",
    "minAreaRect", "resize", "warpPerspective",
]}
white_list = {"": core[""] + imgproc[""]}
