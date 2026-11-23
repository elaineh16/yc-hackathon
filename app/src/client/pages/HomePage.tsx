import { Navigate } from "react-router";
import { getMe, useQuery } from "wasp/client/operations";
import { Spinner } from "../ui";

/** Sends each role to its own workspace. */
export function HomePage() {
  const { data, error } = useQuery(getMe);
  if (error) return <Navigate to="/login" replace />;
  if (!data)
    return (
      <div className="grid min-h-dvh place-items-center">
        <Spinner />
      </div>
    );
  return <Navigate to={data.role === "MANAGER" ? "/ops" : data.role === "CONTRACTOR" ? "/jobs" : "/my"} replace />;
}
