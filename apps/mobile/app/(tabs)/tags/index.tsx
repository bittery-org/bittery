import { Redirect } from "expo-router";

/**
 * Tags now live behind the Tags segment of Browse; this route only keeps the
 * old `/tags` deep link working.
 */
export default function TagsIndexRedirect() {
	return <Redirect href="/(tabs)/vaults?browse=tags" />;
}
