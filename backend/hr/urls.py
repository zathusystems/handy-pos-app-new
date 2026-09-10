from django.urls import include, path
from rest_framework.routers import DefaultRouter

from .views import (
    AttendanceRecordViewSet,
    EmployeeViewSet,
    EmploymentTermViewSet,
    LeaveBalanceViewSet,
    LeaveRequestViewSet,
    LeaveTypeViewSet,
    OvertimeRequestViewSet,
    WorkShiftViewSet,
)
from .payroll_views import (
    PayrollEntryViewSet,
    PayrollLineViewSet,
    PayrollRunViewSet,
    PayrollSettingsViewSet,
)


router = DefaultRouter()
router.register(r'employees', EmployeeViewSet, basename='hr-employee')
router.register(r'employment-terms', EmploymentTermViewSet, basename='hr-employment-term')
router.register(r'shifts', WorkShiftViewSet, basename='hr-shift')
router.register(r'attendance', AttendanceRecordViewSet, basename='hr-attendance')
router.register(r'leave-types', LeaveTypeViewSet, basename='hr-leave-type')
router.register(r'leave-balances', LeaveBalanceViewSet, basename='hr-leave-balance')
router.register(r'leave-requests', LeaveRequestViewSet, basename='hr-leave-request')
router.register(r'overtime-requests', OvertimeRequestViewSet, basename='hr-overtime-request')
router.register(r'payroll-settings', PayrollSettingsViewSet, basename='hr-payroll-settings')
router.register(r'payroll-runs', PayrollRunViewSet, basename='hr-payroll-run')
router.register(r'payroll-entries', PayrollEntryViewSet, basename='hr-payroll-entry')
router.register(r'payroll-lines', PayrollLineViewSet, basename='hr-payroll-line')

urlpatterns = [
    path('', include(router.urls)),
]
