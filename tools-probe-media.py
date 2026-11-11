import asyncio
import time
from datetime import datetime

from winrt.windows.media.control import GlobalSystemMediaTransportControlsSessionManager as Manager


async def main():
    manager = await Manager.request_async()
    sessions = manager.get_sessions()
    print("sessions", len(sessions))
    for session in sessions:
        try:
            info = session.get_playback_info()
            props = await session.try_get_media_properties_async()
            timeline = session.get_timeline_properties()
            last = timeline.last_updated_time
            age = time.time() - last.timestamp() if last else None
            print(
                "SESSION",
                props.title,
                "status",
                int(info.playback_status),
                "pos",
                round(timeline.position.total_seconds(), 2),
                "end",
                round(timeline.end_time.total_seconds(), 2),
                "last_age",
                round(age, 2) if age is not None else None,
                "now",
                round(time.time(), 2),
            )
        except Exception as exc:
            print("ERR", exc)


asyncio.run(main())
