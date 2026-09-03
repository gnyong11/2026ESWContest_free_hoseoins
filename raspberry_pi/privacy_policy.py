"""Privacy-first policy for the living-room camera."""


def living_room_camera_policy(
    *,
    sensor_data_available,
    resident_away,
    front_door_open,
    door_cycle_pending,
    bedroom_present,
    bathroom_present,
    bed_occupied,
):
    """Only request video while a living-room or entrance transition is plausible."""
    if not sensor_data_available:
        return False, "센서 데이터 대기 중"
    if front_door_open or door_cycle_pending:
        return True, "현관 이동 방향 확인 중"
    if resident_away:
        return False, "외출 확인 · 프라이버시 대기"
    if bathroom_present:
        return False, "화장실 재실 확인 · 프라이버시 대기"
    if bedroom_present or bed_occupied:
        return False, "침실 재실 확인 · 프라이버시 대기"
    return True, "거실 재실 가능성 확인 중"
