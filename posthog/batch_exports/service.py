import datetime as dt
from uuid import UUID

from dataclasses import dataclass, asdict
from posthog import settings
from posthog.batch_exports.models import BatchExport, BatchExportRun
from posthog.models.team.team import Team
from posthog.temporal.client import sync_connect
from asgiref.sync import async_to_sync


from temporalio.client import (
    Client,
    Schedule,
    ScheduleActionStartWorkflow,
    ScheduleSpec,
    ScheduleState,
)


class S3BatchExportWorkflow:
    def run(self, inputs):
        raise NotImplementedError


@dataclass
class S3BatchExportInputs:
    """Inputs for S3 export workflow.

    Attributes:
        bucket_name: The S3 bucket we are exporting to.
        region: The AWS region where the bucket is located.
        file_name_prefix: A prefix for the file name to be created in S3.
        batch_window_size: The size in seconds of the batch window.
            For example, for one hour batches, this should be 3600.
        team_id: The team_id whose data we are exporting.
        file_format: The format of the file to be created in S3, supported by ClickHouse.
            A list of all supported formats can be found in https://clickhouse.com/docs/en/interfaces/formats.
        data_interval_end: For manual runs, the end date of the batch. This should be set to `None` for regularly
            scheduled runs and for backfills.
    """

    bucket_name: str
    region: str
    key_template: str
    batch_window_size: int
    team_id: int
    batch_export_id: str
    table_name: str = "events"
    file_format: str = "CSVWithNames"
    partition_key: str | None = None
    aws_access_key_id: str | None = None
    aws_secret_access_key: str | None = None
    data_interval_end: str | None = None


DESTINATION_WORKFLOWS = {
    "S3": ("s3-export", S3BatchExportInputs),
}


@async_to_sync
async def create_schedule(temporal, id: str, schedule: Schedule, search_attributes: dict):
    """Create a Temporal Schedule."""
    return await temporal.create_schedule(
        id=id,
        schedule=schedule,
        search_attributes=search_attributes,
    )


def pause_batch_export(temporal: Client, batch_export_id: str, note: str | None = None) -> None:
    """Pause this BatchExport.

    We pass the call to the underlying BatchExportSchedule. This exists here as a convinience so that users only
    need to interact with a BatchExport.
    """
    BatchExport.objects.filter(id=batch_export_id).update(paused=True)
    pause_schedule(temporal, schedule_id=batch_export_id, note=note)


@async_to_sync
async def pause_schedule(temporal: Client, schedule_id: str, note: str | None = None) -> None:
    """Pause a Temporal Schedule."""
    handle = temporal.get_schedule_handle(schedule_id)
    await handle.pause(note=note)


def unpause_batch_export(temporal: Client, batch_export_id: str, note: str | None = None) -> None:
    """Pause this BatchExport.

    We pass the call to the underlying BatchExportSchedule. This exists here as a convinience so that users only
    need to interact with a BatchExport.
    """
    BatchExport.objects.filter(id=batch_export_id).update(paused=False)
    unpause_schedule(temporal, schedule_id=batch_export_id, note=note)


@async_to_sync
async def unpause_schedule(temporal: Client, schedule_id: str, note: str | None = None) -> None:
    """Unpause a Temporal Schedule."""
    handle = temporal.get_schedule_handle(schedule_id)
    await handle.unpause(note=note)


@async_to_sync
async def delete_schedule(temporal: Client, schedule_id: str) -> None:
    """Delete a Temporal Schedule."""
    handle = temporal.get_schedule_handle(schedule_id)
    await handle.delete()


@async_to_sync
async def describe_schedule(temporal: Client, schedule_id: str):
    """Describe a Temporal Schedule."""
    handle = temporal.get_schedule_handle(schedule_id)
    return await handle.describe()


def backfill_export(batch_export_id: str, start_at: dt.datetime | None = None, end_at: dt.datetime | None = None):
    """Creates an export run for the given BatchExport, and specified time range.
    Arguments:
        start_at: From when to backfill. If this is not defined, then we will backfill since this
            BatchExportSchedule's start_at.
        end_at: Up to when to backfill. If this is not defined, then we will backfill up to this
            BatchExportSchedule's created_at.
    """
    batch_export = BatchExport.objects.get(id=batch_export_id)
    backfill_run = BatchExportRun.objects.create(
        batch_export=batch_export,
        data_interval_start=start_at,
        data_interval_end=end_at,
    )
    (workflow, inputs) = DESTINATION_WORKFLOWS[batch_export.destination.type]
    temporal = sync_connect()
    temporal.execute_workflow(
        workflow,
        inputs(
            team_id=batch_export.pk,
            batch_export_id=batch_export_id,
            data_interval_end=end_at,
            **batch_export.destination.config,
        ),
        task_queue=settings.TEMPORAL_TASK_QUEUE,
        id=str(backfill_run.pk),
    )
    return backfill_run


def create_batch_export_run(
    team_id: int,
    workflow_id: str,
    run_id: str,
    batch_export_id: UUID,
    data_interval_start: str,
    data_interval_end: str,
):
    """Create a BatchExportRun after a Temporal Workflow execution.

    In a first approach, this method is intended to be called only by Temporal Workflows,
    as only the Workflows themselves can know when they start.

    Args:
        data_interval_start:
        data_interval_end:
    """
    team = Team.objects.get(id=team_id)
    run = BatchExportRun(
        team=team,
        batch_export_id=batch_export_id,
        workflow_id=workflow_id,
        run_id=run_id,
        status=BatchExportRun.Status.STARTING,
        data_interval_start=dt.datetime.fromisoformat(data_interval_start),
        data_interval_end=dt.datetime.fromisoformat(data_interval_end),
    )
    run.save()

    return run


def update_batch_export_run_status(run_id: UUID, status: str):
    """Update the status of an BatchExportRun with given id.

    Arguments:
        id: The id of the BatchExportRun to update.
    """
    updated = BatchExportRun.objects.filter(id=run_id).update(status=status)
    if not updated:
        raise ValueError(f"BatchExportRun with id {run_id} not found.")


def create_batch_export(
    batch_export: BatchExport,
):
    """Create a Schedule in Temporal for this BatchExport.

    Returns:
        The ScheduleHandle for the created Temporal Schedule.
    """
    workflow, workflow_inputs = DESTINATION_WORKFLOWS[batch_export.destination.type]

    # These attributes allow us to filter Workflows in Temporal.
    # Temporal adds TemporalScheduledById (the Schedule's id) and TemporalScheduledStartTime (the Action's timestamp).
    common_search_attributes = {
        "DestinationId": [str(batch_export.destination.id)],
        "DestinationType": [batch_export.destination.type],
        "TeamId": [batch_export.team.id],
        "TeamName": [batch_export.team.name],
        "BatchExportId": [str(batch_export.id)],
    }

    state = ScheduleState(
        note=f"Schedule created for BatchExport {batch_export.id} to Destination {batch_export.destination.id} in Team {batch_export.team.id}.",
        paused=batch_export.paused,
    )

    temporal = sync_connect()

    create_schedule(
        temporal,
        id=str(batch_export.id),
        schedule=Schedule(
            action=ScheduleActionStartWorkflow(
                workflow,
                asdict(
                    workflow_inputs(
                        team_id=batch_export.team.id,
                        # We could take the batch_export_id from the Workflow id
                        # But temporal appends a timestamp at the end we would have to parse out.
                        batch_export_id=str(batch_export.id),
                        **batch_export.destination.config,
                    )
                ),
                id=str(batch_export.id),
                task_queue=settings.TEMPORAL_TASK_QUEUE,
                search_attributes=common_search_attributes,
            ),
            spec=ScheduleSpec(),
            state=state,
        ),
        search_attributes=common_search_attributes,
    )
