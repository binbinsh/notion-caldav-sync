from app.hosted.repository import HostedRepository


class _Result:
    results = []


class _Statement:
    def __init__(self, database, sql):
        self.database = database
        self.sql = sql
        self.args = ()

    def bind(self, *args):
        self.args = args
        return self

    async def all(self):
        self.database.last_query = (self.sql, self.args)
        return _Result()


class _Database:
    last_query = None

    def prepare(self, sql):
        return _Statement(self, sql)


async def test_due_connections_ignore_orphaned_old_jobs():
    database = _Database()
    repository = HostedRepository(database)

    await repository.due_connections(10, active_job_timeout_minutes=60)

    sql, args = database.last_query
    assert "COALESCE(j.started_at, j.created_at)>=?" in sql
    assert len(args) == 3
    assert args[1] < args[0]
    assert args[2] == 10
