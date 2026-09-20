"""Hosted multi-tenant service modules.

The hosted package deliberately depends only on the public sync engine. Planner.li
identity is an adapter at the HTTP boundary; no Planner product code lives here.
"""

from .service import HostedService

__all__ = ["HostedService"]
