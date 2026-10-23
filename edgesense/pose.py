"""MediaPipe pose extraction. Runs on-device; only landmarks leave this module."""

from .models import Landmark, PoseFrame


class PoseExtractor:
    def __init__(self) -> None:
        import mediapipe as mp  # imported lazily so the package imports without it

        self._pose = mp.solutions.pose.Pose(static_image_mode=False)

    def extract(self, rgb_frame) -> PoseFrame:
        result = self._pose.process(rgb_frame)
        if not result.pose_landmarks:
            return PoseFrame()
        return PoseFrame(
            landmarks=[
                Landmark(x=lm.x, y=lm.y, z=lm.z, visibility=lm.visibility)
                for lm in result.pose_landmarks.landmark
            ]
        )
