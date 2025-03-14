import hashlib
import os
import re

def memory_str_to_megabytes(memory: str) -> int:
    size_str = memory.strip().lower()  # Normalize the string
    if size_str.endswith('g'):
        # Convert from gigabytes to megabytes
        memory = int(float(size_str[:-1]) * 1024)
    elif size_str.endswith('m'):
        # Already in megabytes, just convert to integer
        memory = int(float(size_str[:-1]))
    elif size_str.endswith('k'):
        # Convert from kilobytes to megabytes
        memory = int(float(size_str[:-1]) / 1024)
    else:
        memory = int(memory)
    return memory


def md5_string(input_string: str) -> str:
    hash_md5 = hashlib.md5()
    hash_md5.update(input_string.encode('utf-8'))
    return hash_md5.hexdigest()


def is_running_in_docker():
    if os.path.exists('/.dockerenv'):
        return True

    try:
        with open('/proc/1/cgroup', 'rt') as f:
            if 'docker' in f.read():
                return True
    except Exception:
        pass

    try:
        with open('/proc/self/cgroup', 'rt') as f:
            content = f.read()
            for line in content.splitlines():
                if re.match(r"^\d+:[\w=]+:/docker(-[ce]e)?/[0-9a-f]{64}$", line):
                    return True
    except Exception:
        pass

    return False


class BigSet:
    def __init__(self, num_partitions=10):
        """
        Initialize the BigSet instance.
        
        Parameters:
        - num_partitions: The number of partitions to divide the set, default is 10.
        """
        self.num_partitions = num_partitions
        self.partitions = [set() for _ in range(num_partitions)]

    def _get_partition(self, item):
        """
        Get the partition index for a given item based on its hash value.
        """
        return hash(item) % self.num_partitions

    def add(self, item):
        """
        Add an item to the BigSet.
        """
        partition_index = self._get_partition(item)
        self.partitions[partition_index].add(item)

    def discard(self, item):
        """
        Remove an item from the BigSet. If the item does not exist, ignore it.
        """
        partition_index = self._get_partition(item)
        self.partitions[partition_index].discard(item)

    def __contains__(self, item):
        """
        Check if an item is in the BigSet using the `in` keyword.
        """
        partition_index = self._get_partition(item)
        return item in self.partitions[partition_index]

    def __len__(self):
        """
        Get the total number of elements in the BigSet using `len()`.
        """
        return sum(len(partition) for partition in self.partitions)

    def __iter__(self):
        """
        Allow iteration over all elements in the BigSet.
        """
        for partition in self.partitions:
            for item in partition:
                yield item

    def __or__(self, other):
        """
        Implement the union operation (`|`) between BigSet and another set.
        """
        result = BigSet(self.num_partitions)
        result.update(self)
        result.update(other)
        return result

    def __ior__(self, other):
        """
        Implement the in-place union operation (`|=`) to update BigSet with another set.
        """
        self.update(other)
        return self

    def __and__(self, other):
        """
        Implement the intersection operation (`&`) between BigSet and another set.
        """
        result = BigSet(self.num_partitions)
        for item in self:
            if item in other:
                result.add(item)
        return result

    def __iand__(self, other):
        """
        Implement the in-place intersection operation (`&=`) to keep only items also in another set.
        """
        to_remove = [item for item in self if item not in other]
        for item in to_remove:
            self.discard(item)
        return self

    def __sub__(self, other):
        """
        Implement the difference operation (`-`) between BigSet and another set.
        """
        result = BigSet(self.num_partitions)
        for item in self:
            if item not in other:
                result.add(item)
        return result

    def __isub__(self, other):
        """
        Implement the in-place difference operation (`-=`) to remove items also in another set.
        """
        for item in other:
            self.discard(item)
        return self

    def __le__(self, other):
        """
        Implement the subset operation (`<=`) to check if BigSet is a subset of another set.
        """
        return all(item in other for item in self)

    def __ge__(self, other):
        """
        Implement the superset operation (`>=`) to check if BigSet is a superset of another set.
        """
        return all(item in self for item in other)

    def __eq__(self, other):
        """
        Implement the equality operation (`==`) to check if BigSet is equal to another set.
        """
        return len(self) == len(other) and all(item in other for item in self)

    def update(self, *others):
        """
        Update BigSet to include elements from other sets.
        """
        for other in others:
            for item in other:
                self.add(item)


def remove_non_alpha_characters(s):
    return re.sub(r'[^A-Za-z0-9]', '', s)