import { Scene } from 'scenes/sceneTypes'
import { preloadedScenes } from 'scenes/scenes'

export const appScenes: Record<Scene, () => any> = {
    [Scene.Error404]: () => ({ default: preloadedScenes[Scene.Error404].component }),
    [Scene.ErrorNetwork]: () => ({ default: preloadedScenes[Scene.ErrorNetwork].component }),
    [Scene.ErrorProjectUnavailable]: () => ({ default: preloadedScenes[Scene.ErrorProjectUnavailable].component }),
    [Scene.Dashboards]: () => import('./dashboard/Dashboards'),
    [Scene.Dashboard]: () => import('./dashboard/Dashboard'),
    [Scene.Insight]: () => import('./insights/Insight'),
    [Scene.InsightRouter]: () => import('./insights/InsightRouter'),
    [Scene.Cohorts]: () => import('./cohorts/Cohorts'),
    [Scene.Events]: () => import('./events/Events'),
    [Scene.Actions]: () => import('./actions/ActionsTable'),
    [Scene.EventStats]: () => import('./events/EventsVolumeTable'),
    [Scene.EventPropertyStats]: () => import('./events/PropertiesVolumeTable'),
    [Scene.SessionRecordings]: () => import('./session-recordings/SessionRecordings'),
    [Scene.Person]: () => import('./persons/Person'),
    [Scene.Persons]: () => import('./persons/Persons'),
    [Scene.Groups]: () => import('./groups/Groups'),
    [Scene.Group]: () => import('./groups/Group'),
    [Scene.Action]: () => import('./actions/Action'), // TODO
    [Scene.Experiments]: () => import('./experiments/Experiments'),
    [Scene.FeatureFlags]: () => import('./feature-flags/FeatureFlags'),
    [Scene.FeatureFlag]: () => import('./feature-flags/FeatureFlag'),
    [Scene.OrganizationSettings]: () => import('./organization/Settings'),
    [Scene.OrganizationCreateFirst]: () => import('./organization/Create'),
    [Scene.ProjectSettings]: () => import('./project/Settings'),
    [Scene.ProjectCreateFirst]: () => import('./project/Create'),
    [Scene.SystemStatus]: () => import('./instance/SystemStatus'),
    [Scene.Licenses]: () => import('./instance/Licenses'),
    [Scene.MySettings]: () => import('./me/Settings'),
    [Scene.Annotations]: () => import('./annotations'),
    [Scene.PreflightCheck]: () => import('./PreflightCheck'),
    [Scene.Signup]: () => import('./authentication/Signup'),
    [Scene.InviteSignup]: () => import('./authentication/InviteSignup'),
    [Scene.Ingestion]: () => import('./ingestion/IngestionWizard'),
    [Scene.Billing]: () => import('./billing/Billing'),
    [Scene.BillingSubscribed]: () => import('./billing/BillingSubscribed'),
    [Scene.Plugins]: () => import('./plugins/Plugins'),
    [Scene.Personalization]: () => import('./onboarding/Personalization'),
    [Scene.OnboardingSetup]: () => import('./onboarding/OnboardingSetup'),
    [Scene.Login]: () => import('./authentication/Login'),
    [Scene.SavedInsights]: () => import('./saved-insights/SavedInsights'),
    [Scene.PasswordReset]: () => import('./authentication/PasswordReset'),
    [Scene.PasswordResetComplete]: () => import('./authentication/PasswordResetComplete'),
}
